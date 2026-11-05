/**
 * 提醒（所有人可用，程序级）。
 *
 * 为什么不让模型自己定时：agy 的 schedule 工具会把整轮挂起到点（期间收不到新消息，2026-11-05 漏接），
 * 访客也没有执行 systemd-run 的权限。所以提醒由适配器存、适配器到点发：
 * - `/remind <时间> <内容>`、`/reminders`、`/remind del <编号>` 直接由程序处理；
 * - 自然语言（「明早 8 点叫我开会」）由模型在回复里写标记 `[提醒:2026-11-06 08:00|开会]`，
 *   适配器取出标记、从回复里抹掉，并把提醒绑定到**这条消息的真实发送者和会话**——模型指定不了别人。
 *
 * 到点：群里 `@TA ⏰ …`，私聊直接发。机器人停机期间到点的，重新连上后补发并注明晚了多久；超过 24 小时的丢弃。
 * 状态存 ~/.dsh-qqbot/reminders.json（0600）。时间一律按北京时间理解。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { envNumber } from './group-chime.ts';

export const DEFAULT_REMINDERS_FILE = resolve(homedir(), '.dsh-qqbot', 'reminders.json');

const CST_OFFSET_MS = 8 * 3600_000;
const MINUTE = 60_000;
const DAY = 24 * 3600_000;

export interface Reminder {
  id: string;
  scope: 'c2c' | 'group';
  targetId: string;
  userId: string;
  text: string;
  dueAt: number;
  createdAt: number;
  /** 发送失败（不含断线期间）的次数 */
  attempts?: number;
}

export interface ReminderLimits {
  maxPerUser: number;
  maxTextChars: number;
  minAheadMs: number;
  maxAheadMs: number;
  /** 到点后最多晚多久还补发 */
  maxLateMs: number;
  tickMs: number;
}

export const DEFAULT_REMINDER_LIMITS: ReminderLimits = {
  maxPerUser: envNumber('NAPCAT_REMINDER_MAX_PER_USER', 10, 1, 100, true),
  maxTextChars: 200,
  minAheadMs: 30_000,
  maxAheadMs: 365 * DAY,
  maxLateMs: DAY,
  tickMs: 20_000,
};

/** 北京时间的年月日时分、星期（0=周日），不依赖系统时区 */
export function cstFields(ms: number): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const t = new Date(ms + CST_OFFSET_MS);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), dow: t.getUTCDay() };
}

/** 北京时间 → 时间戳；月日越界按 Date.UTC 的规则顺延 */
export function cstToMs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi) - CST_OFFSET_MS;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 北京日期 YYYY-MM-DD */
export function cstDate(ms: number): string {
  const f = cstFields(ms);
  return `${f.y}-${pad(f.mo)}-${pad(f.d)}`;
}

/** 给人看的时间：今天/明天/后天 HH:MM，同年 MM-DD HH:MM，否则带年份 */
export function formatWhen(ms: number, now = Date.now()): string {
  const f = cstFields(ms);
  const hm = `${pad(f.h)}:${pad(f.mi)}`;
  const n = cstFields(now);
  const dayDiff = Math.round((cstToMs(f.y, f.mo, f.d) - cstToMs(n.y, n.mo, n.d)) / DAY);
  if (dayDiff === 0) return `今天 ${hm}`;
  if (dayDiff === 1) return `明天 ${hm}`;
  if (dayDiff === 2) return `后天 ${hm}`;
  if (f.y === n.y) return `${pad(f.mo)}-${pad(f.d)} ${hm}`;
  return `${f.y}-${pad(f.mo)}-${pad(f.d)} ${hm}`;
}

// ───────────────────────── 时间解析 ─────────────────────────

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUM_SRC = '\\d{1,4}|[零〇一二两俩三四五六七八九十]{1,4}';

/** 「十五」「二十三」「两」「12」→ 数字；不认识返回 NaN */
export function parseNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零〇一二两俩三四五六七八九十]+$/.test(s)) return NaN;
  if (!s.includes('十')) return s.split('').reduce((n, c) => n * 10 + (CN_DIGITS[c] ?? NaN), 0);
  const [a, b] = s.split('十');
  const tens = a ? (CN_DIGITS[a] ?? NaN) : 1;
  const ones = b ? (CN_DIGITS[b] ?? NaN) : 0;
  return tens * 10 + ones;
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(秒钟?|s|sec)$/i, 1000],
  [/^(分钟?|min|m)$/i, MINUTE],
  [/^(个?小时|个?钟头|h|hr)$/i, 60 * MINUTE],
  [/^(天|d)$/i, DAY],
  [/^(周|个?星期|个?礼拜|w)$/i, 7 * DAY],
];

const REL_PART_RE = new RegExp(`^\\s*(${NUM_SRC}|半)\\s*(秒钟?|分钟?|个?小时|个?钟头|天|周|个?星期|个?礼拜|min|sec|hr|[smhdw])(?![a-z])\\s*(半)?`, 'i');
const REL_TAIL_RE = /^\s*(后|之后|以后)/;
const PERIOD_RE = /^(凌晨|早上|早晨|清晨|上午|中午|午后|下午|傍晚|晚上|夜里|夜间|半夜)/;
const DAY_WORD_RE = /^(今天|今日|今早|今晚|今夜|明天|明日|明早|明晚|后天|大后天)/;
const WEEKDAY_RE = /^(下下|下个?|这个?|本)?(周|星期|礼拜)([一二三四五六日天1-7])/;
const CLOCK_RE = new RegExp(`^(${NUM_SRC})\\s*(?:[:：]\\s*(\\d{1,2})(?:[:：]\\d{1,2})?|(?:点|时)\\s*(?:(半)|(一刻)|(三刻)|(${NUM_SRC})\\s*分?)?)`);
const ABS_DATE_RE = /^(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/;

interface Clock { h: number; mi: number }

function readClock(s: string): { clock: Clock; len: number } | null {
  const m = CLOCK_RE.exec(s);
  if (!m) return null;
  const h = parseNum(m[1]!);
  let mi = 0;
  if (m[2] !== undefined) mi = Number(m[2]);
  else if (m[3]) mi = 30;
  else if (m[4]) mi = 15;
  else if (m[5]) mi = 45;
  else if (m[6]) mi = parseNum(m[6]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return null;
  return { clock: { h: h === 24 ? 0 : h, mi }, len: m[0].length };
}

/** 按时段把 12 小时制换成 24 小时制 */
function applyPeriod(h: number, period: string | undefined): number {
  if (!period) return h;
  if (/下午|午后|傍晚|晚上|夜里|夜间|今晚|明晚|今夜/.test(period)) return h < 12 ? h + 12 : h;
  if (/中午/.test(period)) return h < 11 ? h + 12 : h;
  if (/半夜|凌晨/.test(period)) return h === 12 ? 0 : h;
  return h; // 早上 / 上午
}

/** 只写了时段没写钟点时的默认时间 */
function defaultClockFor(period: string | undefined): Clock {
  if (!period) return { h: 9, mi: 0 };
  if (/凌晨|半夜/.test(period)) return { h: 1, mi: 0 };
  if (/早|清晨/.test(period)) return { h: 8, mi: 0 };
  if (/上午/.test(period)) return { h: 9, mi: 0 };
  if (/中午/.test(period)) return { h: 12, mi: 0 };
  if (/下午|午后/.test(period)) return { h: 15, mi: 0 };
  if (/傍晚/.test(period)) return { h: 18, mi: 0 };
  return { h: 20, mi: 0 }; // 晚上 / 今晚 / 明晚
}

/**
 * 从开头解析一个时间表达，返回时间戳和剩下的文字。认得：
 * - 相对：10分钟后、1小时30分钟后、半小时后、2天后、1h30m、90s
 * - 绝对：2026-11-06 08:00、11-06 8:00、11月6日 下午3点
 * - 口语：明天8点、明早、今晚九点半、后天下午三点一刻、周五 9:00、下周一早上
 * - 只有钟点：18:30、下午3点（今天已过就算明天）
 * 认不出返回 null。
 */
export function parseWhen(input: string, now = Date.now()): { at: number; rest: string } | null {
  let s = input.trim().replace(/^(在|于)\s*/, '').replace(new RegExp(`(${NUM_SRC})个半(小时|钟头)`), '$1个小时半');

  // 相对时间（「后」可写可不写：10分钟后 / 10分钟 / 1h30m）
  {
    let total = 0;
    let t = s;
    let matched = false;
    for (let i = 0; i < 4; i++) {
      const m = REL_PART_RE.exec(t);
      if (!m) break;
      const unit = UNIT_MS.find(([re]) => re.test(m[2]!))?.[1];
      const n = m[1] === '半' ? 0.5 : parseNum(m[1]!);
      if (!unit || !Number.isFinite(n)) break;
      total += n * unit + (m[3] ? unit / 2 : 0);
      t = t.slice(m[0].length);
      matched = true;
    }
    if (matched && total > 0) {
      const tail = REL_TAIL_RE.exec(t);
      if (tail) t = t.slice(tail[0].length);
      return { at: now + Math.round(total), rest: t.replace(/^[的，,、:：\s]+/, '').trim() };
    }
  }

  const today = cstFields(now);
  let y = today.y, mo = today.mo, d = today.d;
  let dateGiven = false;
  let plainWeekday = false;
  let dayWord: string | undefined;

  const abs = ABS_DATE_RE.exec(s);
  if (abs && (abs[1] || /[-/月]/.test(abs[0]))) {
    y = abs[1] ? Number(abs[1]) : today.y;
    mo = Number(abs[2]);
    d = Number(abs[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    dateGiven = true;
    s = s.slice(abs[0].length).trim();
  } else {
    const dw = DAY_WORD_RE.exec(s);
    if (dw) {
      dayWord = dw[1]!;
      const offset = /^大后天/.test(dayWord) ? 3 : /^后天/.test(dayWord) ? 2 : /^明/.test(dayWord) ? 1 : 0;
      const base = cstToMs(today.y, today.mo, today.d) + offset * DAY;
      ({ y, mo, d } = cstFields(base + 12 * 3600_000));
      dateGiven = true;
      s = s.slice(dw[0].length).trim();
    } else {
      const wd = WEEKDAY_RE.exec(s);
      if (wd) {
        const target = wd[3] === '日' || wd[3] === '天' || wd[3] === '7' ? 0 : (/\d/.test(wd[3]!) ? Number(wd[3]) : parseNum(wd[3]!));
        const todayMs = cstToMs(today.y, today.mo, today.d);
        let dayMs: number;
        if (wd[1]) {
          // 下周X / 下下周X / 这周X：按「周一开头」的自然周算
          const monday = todayMs - ((today.dow + 6) % 7) * DAY;
          const weeks = wd[1].startsWith('下下') ? 2 : wd[1].startsWith('下') ? 1 : 0;
          dayMs = monday + (weeks * 7 + (target + 6) % 7) * DAY;
        } else {
          // 周X：最近的一个（今天就是周X 时算今天，时间过了再顺延一周，见下面）
          dayMs = todayMs + ((target - today.dow + 7) % 7) * DAY;
          plainWeekday = true;
        }
        ({ y, mo, d } = cstFields(dayMs + 12 * 3600_000));
        dateGiven = true;
        dayWord = wd[0];
        s = s.slice(wd[0].length).trim();
      }
    }
  }

  const pm = PERIOD_RE.exec(s);
  const period = pm?.[1] ?? (dayWord && /早|晚|夜/.test(dayWord) ? dayWord : undefined);
  if (pm) s = s.slice(pm[0].length).trim();

  const ck = readClock(s);
  let clock: Clock;
  if (ck) {
    clock = { h: applyPeriod(ck.clock.h, period), mi: ck.clock.mi };
    s = s.slice(ck.len).trim();
  } else if (dateGiven || period) {
    clock = defaultClockFor(period);
  } else {
    return null;
  }
  if (clock.h > 23) return null;

  let at = cstToMs(y, mo, d, clock.h, clock.mi);
  if (!dateGiven && at <= now) at += DAY;               // 只写钟点、今天已过 → 明天
  if (plainWeekday && at <= now) at += 7 * DAY;         // 「周五 9 点」今天就是周五但已过 → 下周五
  if (dateGiven && abs && !abs[1] && at < now - DAY) {  // 「1-5 9:00」写在 11 月 → 明年
    at = cstToMs(y + 1, mo, d, clock.h, clock.mi);
  }
  return { at, rest: s.replace(/^[的，,、:：\s]+/, '').trim() };
}

/** 提醒内容：去掉「提醒我/叫我」等引导词，压成一行 */
export function cleanReminderText(text: string, max = DEFAULT_REMINDER_LIMITS.maxTextChars): string {
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^(?:[，,、:：\s]|提醒我|提醒一下|提醒|叫我|喊我|记得|要|去)+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

// ───────────────────────── 回复里的提醒标记 ─────────────────────────

const MARKER_RE = /\[\s*提醒\s*[:：]([^\]\n]{0,400})\]/g;

/**
 * 取出回复里的 `[提醒:时间|内容]` 标记，并把所有这类标记从正文抹掉。
 * 时间可以是「2026-11-06 08:00」也可以是「30分钟后」。分隔符认 | 和全角｜。
 */
export function extractReminderMarkers(raw: string): { clean: string; items: Array<{ when: string; text: string }> } {
  const items: Array<{ when: string; text: string }> = [];
  const SENTINEL = '\u0000';
  const marked = raw.replace(/\u0000/g, '').replace(MARKER_RE, (_m, body: string) => {
    const i = body.search(/[|｜]/);
    if (i >= 0) items.push({ when: body.slice(0, i).trim(), text: body.slice(i + 1).trim() });
    else items.push({ when: body.trim(), text: '' });
    return SENTINEL;
  });
  if (items.length === 0) return { clean: raw, items };
  // 标记单独占一行的，连这一行一起删掉；夹在句子里的只删标记
  const clean = marked
    .replace(/^[ \t]*(?:\u0000[ \t]*)+(?:\r?\n|$)/gm, '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, items };
}

/** 用户这条消息像是在要提醒（用来在提示词里提醒模型写标记） */
export const REMIND_INTENT_RE = /提醒我|提醒一下|叫我|喊我|叫醒|闹钟|定个?时|到点|别让我忘|记得.{0,12}(叫|提醒|喊)/;
/** 模型口头答应了提醒（用来发现「答应了却没写标记」） */
export const REMIND_PROMISE_RE = /(会|到时|到点|准时|定时|帮你|记得).{0,8}(提醒|叫|喊)|提醒你|叫你起|喊你|已经?设好|设好了提醒/;

// ───────────────────────── 存储与调度 ─────────────────────────

/** 投递结果：sent 已发；retry 暂时发不了（断线等），不计失败次数；failed 发送报错，计一次失败 */
export type ReminderDeliverResult = 'sent' | 'retry' | 'failed';
export type ReminderDeliver = (r: Reminder, lateMs: number) => Promise<ReminderDeliverResult>;

export class ReminderStore {
  private readonly list: Reminder[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public constructor(
    private readonly deliver: ReminderDeliver,
    private readonly file: string | null = DEFAULT_REMINDERS_FILE,
    private readonly limits: ReminderLimits = DEFAULT_REMINDER_LIMITS,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as { reminders?: Reminder[] };
      for (const r of d.reminders ?? []) {
        if (r && r.id && r.userId && r.targetId && (r.scope === 'c2c' || r.scope === 'group') && Number.isFinite(r.dueAt) && typeof r.text === 'string') {
          this.list.push(r);
        }
      }
    } catch (err) {
      console.warn('[Reminders] reminders.json 读取失败，从空开始:', err instanceof Error ? err.message : err);
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ reminders: this.list }, null, 1), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[Reminders] save failed:', err instanceof Error ? err.message : err);
    }
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(3).toString('hex').slice(0, 4);
      if (!this.list.some(r => r.id === id)) return id;
    }
  }

  public get size(): number {
    return this.list.length;
  }

  /** 新建提醒。校验时间范围、内容长度、每人数量上限 */
  public add(input: { scope: 'c2c' | 'group'; targetId: string; userId: string; text: string; dueAt: number }, now = Date.now()):
    { ok: true; reminder: Reminder } | { ok: false; error: string } {
    const text = cleanReminderText(input.text, this.limits.maxTextChars);
    if (!text) return { ok: false, error: '没写要提醒什么' };
    if (!Number.isFinite(input.dueAt)) return { ok: false, error: '时间没看懂' };
    if (input.dueAt < now + this.limits.minAheadMs) return { ok: false, error: input.dueAt <= now ? '这个时间已经过去了' : '时间太近了，至少一分钟以后' };
    if (input.dueAt > now + this.limits.maxAheadMs) return { ok: false, error: '最多只能设一年以内的提醒' };
    const mine = this.list.filter(r => r.userId === input.userId).length;
    if (mine >= this.limits.maxPerUser) return { ok: false, error: `每人最多 ${this.limits.maxPerUser} 个待提醒，先删掉几个吧（/reminders 查看）` };
    const reminder: Reminder = {
      id: this.newId(), scope: input.scope, targetId: input.targetId, userId: input.userId,
      text, dueAt: input.dueAt, createdAt: now,
    };
    this.list.push(reminder);
    this.list.sort((a, b) => a.dueAt - b.dueAt);
    this.save();
    return { ok: true, reminder };
  }

  /** 某人的提醒；给了会话就只看这个会话里的 */
  public listFor(userId: string, scope?: 'c2c' | 'group', targetId?: string): Reminder[] {
    return this.list.filter(r => r.userId === userId && (!scope || (r.scope === scope && r.targetId === targetId)));
  }

  /** 删除自己的提醒（管理员可以删任何人的）。返回被删的那条 */
  public remove(userId: string, id: string, isAdmin = false): Reminder | null {
    const i = this.list.findIndex(r => r.id === id.toLowerCase() && (isAdmin || r.userId === userId));
    if (i < 0) return null;
    const [r] = this.list.splice(i, 1);
    this.save();
    return r ?? null;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.limits.tickMs);
    this.timer.unref?.();
    void this.tick();
  }

  public stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.save();
  }

  /** 到点的逐条投递（一轮最多 20 条，避免刷屏/风控）。public 便于测试 */
  public async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = this.list.filter(r => r.dueAt <= now).slice(0, 20);
      let changed = false;
      for (const r of due) {
        const late = now - r.dueAt;
        if (late > this.limits.maxLateMs) {
          console.warn(`[Reminders] ${r.id} for ${r.userId} is ${Math.round(late / 3600_000)}h late, dropped`);
          this.drop(r);
          changed = true;
          continue;
        }
        let res: ReminderDeliverResult;
        try {
          res = await this.deliver(r, late);
        } catch {
          res = 'failed';
        }
        if (res === 'sent') {
          this.drop(r);
          changed = true;
        } else if (res === 'failed') {
          r.attempts = (r.attempts ?? 0) + 1;
          changed = true;
          if (r.attempts >= 5) {
            console.warn(`[Reminders] ${r.id} for ${r.userId} failed 5 times, dropped`);
            this.drop(r);
          }
        } else {
          break; // 断线：后面的也发不出去，等下一轮
        }
      }
      if (changed) this.save();
    } finally {
      this.ticking = false;
    }
  }

  private drop(r: Reminder): void {
    const i = this.list.indexOf(r);
    if (i >= 0) this.list.splice(i, 1);
  }
}
