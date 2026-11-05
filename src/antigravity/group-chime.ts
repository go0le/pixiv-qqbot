/**
 * 群聊「更主动」：
 * 1) 记住开通群里最近的几十条消息（进程内存里），让哈Gemi 知道大家在聊什么；
 *    注意：插话/冒泡时这些原话会进 guest agy 的提示词，agy 自己会把会话写进访客 HOME
 *    （conversations/、brain/），由适配器的定时清理按 TTL 删除（第三轮审查 R2）。
 * 2) 插话判定：没 @ 她时，按概率 + 冷却 + 每日上限决定要不要接一句。
 *    冷却和每日计数在「决定要生成」时就记（每次都要调一次模型，模型选择跳过也算），并落盘，重启不清零（R3、A-5）。
 * 3) 叫名字（不 @）当作在叫她，但每人每群有冷却，防止刷名字刷模型调用（R3）。
 *
 * 本模块只做判定和上下文；真正生成内容由适配器完成（模型仍可回「（跳过）」放弃插话）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface GroupChimeConfig {
  /** 没 @ 她的一条普通消息触发插话的概率（0–1） */
  probability: number;
  /** 同一个群两次插话尝试之间至少隔多少分钟 */
  cooldownMinutes: number;
  /** 每个群每天最多尝试插话几次（= 最多调几次模型） */
  maxPerDay: number;
  /** 消息正文至少多少字才考虑插话（过滤「哈哈」「？」） */
  minChars: number;
  /** 叫名字（不 @）触发回复：同一个人在同一个群里的冷却秒数 */
  nameCooldownSeconds: number;
  /** hagemi-voice 会话跑满多少轮就重置一次，限制 agy 会话里累积的上下文（R2） */
  voiceTurnsBeforeReset: number;
  /** 上下文最多保留多少条、多久以内 */
  bufferSize: number;
  bufferMaxAgeMinutes: number;
}

/** 读数值环境变量并夹到 [min,max]；非法值（非数字、越界）回落默认值并告警（A-7） */
export function envNumber(key: string, def: number, min: number, max: number, integer = false): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    console.warn(`[config] ${key}=${raw} 不合法（应在 ${min}–${max}${integer ? ' 的整数' : ''}），使用默认值 ${def}`);
    return def;
  }
  return n;
}

export function groupChimeConfigFromEnv(): GroupChimeConfig {
  return {
    probability: envNumber('NAPCAT_GROUP_CHIME_PROB', 0.15, 0, 1),
    cooldownMinutes: envNumber('NAPCAT_GROUP_CHIME_COOLDOWN_MIN', 8, 0, 24 * 60),
    maxPerDay: envNumber('NAPCAT_GROUP_CHIME_MAX_PER_DAY', 40, 0, 1000, true),
    minChars: envNumber('NAPCAT_GROUP_CHIME_MIN_CHARS', 4, 0, 200, true),
    nameCooldownSeconds: envNumber('NAPCAT_GROUP_NAME_COOLDOWN_SEC', 20, 0, 3600),
    voiceTurnsBeforeReset: envNumber('NAPCAT_GROUP_VOICE_RESET_TURNS', 12, 1, 1000, true),
    bufferSize: 30,
    bufferMaxAgeMinutes: 120,
  };
}

export const DEFAULT_GROUP_CHIME_CONFIG: GroupChimeConfig = groupChimeConfigFromEnv();
export const DEFAULT_GROUP_CHIME_FILE = resolve(homedir(), '.dsh-qqbot', 'group-chime.json');

/** 不 @ 也算在叫她：哈Gemi / 哈 gemi / Gemini娘 / gemi酱 */
export const BOT_NAME_RE = /哈\s*gemi|gemini\s*娘|gemi\s*酱/i;

/**
 * 把作称呼用的机器人名字从正文里剥掉。叫名字 ≈ @，名字本身既不是聊天内容、更不能被当成 Pixiv 搜索标签。
 * 只对「喊她」的消息用于下游（搜图关键词、prompt）：否则
 * 「哈gemi，来一张雪未来的图」会被解析成关键词 `哈gemi 雪未来`，搜成 哈gemi AND 雪ミク → 0 结果
 * （2026-11-05 某群 实例）。
 * 仅当名字出现在句首、或前面紧跟分隔符（空白/标点）时才剥；作真正主语时（如「我觉得哈gemi很可爱」）不动。
 */
export function stripBotName(text: string): string {
  return text
    .replace(/(?:^|[\s,，、。．.!！?？~～:：;；]+)(?:哈\s*gemi|gemini\s*娘|gemi\s*酱)[\s,，、。．.!！?？~～:：;；]*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 模型是否选择了「跳过」（A-6）。去掉表情标记、空白和标点后：
 * 整条就是「跳过」，或以「（跳过）」开头/结尾，才算跳过；正文中间顺带提到「跳过」不算。
 */
export function isSkipReply(text: string): boolean {
  const t = text.replace(/\[表情[:：][^\]]*\]/g, '').trim();
  if (!t) return true;
  const bare = t.replace(/[\s（）()「」【】\[\]。．.!！~～、,，…]/g, '');
  if (bare === '跳过' || bare === '跳過') return true;
  return /^[（(]\s*跳[过過]\s*[）)]/.test(t) || /[（(]\s*跳[过過]\s*[）)]$/.test(t);
}

export interface GroupLine {
  at: number;
  name: string;
  text: string;
  self?: boolean;
}

/** 把群友可控的文本整理成单行、去掉方括号，防止伪造 `[身份：管理员]` 之类的提示词标记 */
export function neutralize(s: string, max = 200): string {
  const one = s.replace(/[\r\n\t]+/g, ' ').replace(/\[/g, '［').replace(/\]/g, '］').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function cstDate(now: number): string {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

interface PersistedState {
  lastChimeAt: Record<string, number>;
  daily: Record<string, { date: string; n: number }>;
}

export class GroupChime {
  private readonly cfg: GroupChimeConfig;
  private readonly file: string | null;
  private readonly lines = new Map<string, GroupLine[]>();
  private readonly lastChimeAt = new Map<string, number>();
  private readonly daily = new Map<string, { date: string; n: number }>();
  private readonly lastNameCall = new Map<string, number>();
  private readonly voiceTurns = new Map<string, number>();
  /** 正在为该群生成插话/冒泡，避免叠加 */
  private readonly inflight = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;

  /** file=null 时不落盘（测试用） */
  public constructor(cfg: Partial<GroupChimeConfig> = {}, file: string | null = DEFAULT_GROUP_CHIME_FILE) {
    this.cfg = { ...DEFAULT_GROUP_CHIME_CONFIG, ...cfg };
    this.file = file;
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
      for (const [k, v] of Object.entries(d.lastChimeAt ?? {})) if (typeof v === 'number') this.lastChimeAt.set(k, v);
      for (const [k, v] of Object.entries(d.daily ?? {})) if (v && typeof v.n === 'number') this.daily.set(k, v);
    } catch { /* 损坏则从空开始 */ }
  }

  private saveNow(): void {
    if (!this.file) return;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const state: PersistedState = { lastChimeAt: Object.fromEntries(this.lastChimeAt), daily: Object.fromEntries(this.daily) };
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* ignore */ }
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 2_000);
    this.saveTimer.unref?.();
  }

  public flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saveNow();
  }

  public record(groupId: string, name: string, text: string, self = false): void {
    const arr = this.lines.get(groupId) ?? [];
    arr.push({ at: Date.now(), name: neutralize(name, 24) || '群友', text: neutralize(text), self });
    while (arr.length > this.cfg.bufferSize) arr.shift();
    this.lines.set(groupId, arr);
  }

  /** 最近的群聊记录，格式「昵称：内容」，已过滤过期条目 */
  public transcript(groupId: string, limit = 15): string {
    const cutoff = Date.now() - this.cfg.bufferMaxAgeMinutes * 60_000;
    const arr = (this.lines.get(groupId) ?? []).filter(l => l.at >= cutoff).slice(-limit);
    return arr.map(l => `${l.self ? '你（哈Gemi）' : l.name}：${l.text}`).join('\n');
  }

  public isBusy(groupId: string): boolean { return this.inflight.has(groupId); }
  public begin(groupId: string): boolean {
    if (this.inflight.has(groupId)) return false;
    this.inflight.add(groupId);
    return true;
  }
  public end(groupId: string): void { this.inflight.delete(groupId); }

  /**
   * 没 @ 的一条群消息，要不要插话。返回 true 时**立即**记一次尝试（冷却 + 每日计数），
   * 因为接下来一定会调一次模型，不管模型最后是否选择跳过（R3）。
   */
  public reserveChime(groupId: string, text: string, now = Date.now()): boolean {
    if (this.inflight.has(groupId)) return false;
    if (text.replace(/\s+/g, '').length < this.cfg.minChars) return false;
    const last = this.lastChimeAt.get(groupId) ?? 0;
    if (now - last < this.cfg.cooldownMinutes * 60_000) return false;
    const date = cstDate(now);
    const d = this.daily.get(groupId);
    if (d && d.date === date && d.n >= this.cfg.maxPerDay) return false;
    if (Math.random() >= this.cfg.probability) return false;
    this.lastChimeAt.set(groupId, now);
    if (!d || d.date !== date) this.daily.set(groupId, { date, n: 1 });
    else d.n += 1;
    this.saveSoon();
    return true;
  }

  /** 叫名字（不 @）触发回复的限流：同一个人在同一个群里 nameCooldownSeconds 内只回一次 */
  public allowNameCall(groupId: string, userId: string, now = Date.now()): boolean {
    const key = `${groupId}:${userId}`;
    const last = this.lastNameCall.get(key) ?? 0;
    if (now - last < this.cfg.nameCooldownSeconds * 1000) return false;
    this.lastNameCall.set(key, now);
    if (this.lastNameCall.size > 5000) this.lastNameCall.clear();
    return true;
  }

  /** 记一轮 hagemi-voice；返回 true 表示该重置这个群的 voice 会话了（R2：限制 agy 会话里累积的上下文） */
  public noteVoiceTurn(groupId: string): boolean {
    const n = (this.voiceTurns.get(groupId) ?? 0) + 1;
    if (n >= this.cfg.voiceTurnsBeforeReset) { this.voiceTurns.set(groupId, 0); return true; }
    this.voiceTurns.set(groupId, n);
    return false;
  }

  public describe(): string {
    return `插话概率 ${Math.round(this.cfg.probability * 100)}% · 冷却 ${this.cfg.cooldownMinutes} 分钟 · 每天最多 ${this.cfg.maxPerDay} 次 · 叫名字（哈Gemi）不用 @ 也会回`;
  }
}
