/**
 * 主动消息调度（参考 DBJD-CR/astrbot_plugin_proactive_chat 的机制，移植到本适配器）。
 *
 * 机制（对齐参考插件）：
 * - 每个会话一个「沉默计时」：用户发消息 → 清零未回复次数、在 [min,max] 分钟内随机安排下一次主动消息；
 * - 免打扰时段内不发，顺延到时段结束；
 * - 连续主动发了 N 次用户都没回 → 暂停，直到用户再次说话；
 * - 状态持久化到 JSON，重启后恢复。
 *
 * 在参考插件之上额外加的保守约束（防打扰、防风控）：
 * - 只对私聊生效；群聊不主动；
 * - 默认关闭，需用户自己发 `/proactive on` 开通（opt-in）；
 * - 每人每天最多 maxPerDay 条；
 * - 全局可关：NAPCAT_PROACTIVE=0。
 *
 * 本模块只管「什么时候、对谁」发；真正「发什么内容」由注入的 deliver 回调完成（走人设 + 记忆 + 出站整形）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { envNumber } from './group-chime.ts';

export interface ProactiveConfig {
  minMinutes: number;
  maxMinutes: number;
  /** 免打扰开始小时（含），北京时间 24h */
  quietStart: number;
  /** 免打扰结束小时（不含），北京时间 24h */
  quietEnd: number;
  maxUnanswered: number;
  maxPerDay: number;
  /** 调度检查间隔（毫秒） */
  tickMs: number;
  /** 单次投递（含模型回合）最长等待；超时就不再等它，避免一个慢回合挡住其他会话（R4） */
  deliverTimeoutMs: number;
  /** 同一轮 tick 里最多同时投递几个会话（不同会话互不阻塞，R4） */
  concurrency: number;
}

/**
 * 从 `${prefix}_MIN_MIN` 等环境变量读配置，缺省用 defaults（私聊前缀 NAPCAT_PROACTIVE，群聊 NAPCAT_GROUP_PROACTIVE）。
 * 非法值（非数字、越界、小时不在 0–23）回落默认值并告警（A-7）；max<min 时把 max 抬到 min。
 */
export function proactiveConfigFromEnv(prefix: string, defaults: Omit<ProactiveConfig, 'tickMs' | 'deliverTimeoutMs' | 'concurrency'>): ProactiveConfig {
  const minMinutes = envNumber(`${prefix}_MIN_MIN`, defaults.minMinutes, 1, 7 * 24 * 60);
  let maxMinutes = envNumber(`${prefix}_MAX_MIN`, defaults.maxMinutes, 1, 7 * 24 * 60);
  if (maxMinutes < minMinutes) {
    console.warn(`[config] ${prefix}_MAX_MIN(${maxMinutes}) < MIN_MIN(${minMinutes})，按 MIN_MIN 处理`);
    maxMinutes = minMinutes;
  }
  return {
    minMinutes,
    maxMinutes,
    quietStart: envNumber(`${prefix}_QUIET_START`, defaults.quietStart, 0, 23, true),
    quietEnd: envNumber(`${prefix}_QUIET_END`, defaults.quietEnd, 0, 23, true),
    maxUnanswered: envNumber(`${prefix}_MAX_UNANSWERED`, defaults.maxUnanswered, 0, 100, true),
    maxPerDay: envNumber(`${prefix}_MAX_PER_DAY`, defaults.maxPerDay, 0, 1000, true),
    tickMs: 60_000,
    deliverTimeoutMs: envNumber(`${prefix}_DELIVER_TIMEOUT_SEC`, 180, 10, 1800) * 1000,
    concurrency: envNumber(`${prefix}_CONCURRENCY`, 3, 1, 20, true),
  };
}

/** 私聊：低频、opt-in */
export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = proactiveConfigFromEnv('NAPCAT_PROACTIVE', {
  minMinutes: 180, maxMinutes: 720, quietStart: 23, quietEnd: 8, maxUnanswered: 2, maxPerDay: 1,
});

/** 群聊冷场冒泡：群里沉默 40–150 分钟后随机冒个泡；1–8 点不冒；冒泡 2 次没人理就暂停到有人说话 */
export const DEFAULT_GROUP_PROACTIVE_CONFIG: ProactiveConfig = proactiveConfigFromEnv('NAPCAT_GROUP_PROACTIVE', {
  minMinutes: 40, maxMinutes: 150, quietStart: 1, quietEnd: 8, maxUnanswered: 2, maxPerDay: 8,
});

export const DEFAULT_PROACTIVE_FILE = resolve(homedir(), '.dsh-qqbot', 'proactive.json');
export const DEFAULT_GROUP_PROACTIVE_FILE = resolve(homedir(), '.dsh-qqbot', 'proactive-group.json');

interface ProactiveSession {
  userId: string;
  enabled: boolean;
  lastUserAt: number;
  /** 下一次计划主动发消息的时间（ms）；0 表示没有待执行任务 */
  nextAt: number;
  /** 连续主动发出、用户未回复的次数 */
  unanswered: number;
  /** 最近一次主动发送的北京日期 YYYY-MM-DD */
  sentDate: string;
  /** 当天已主动发送条数 */
  sentToday: number;
}

/**
 * 返回 true 表示本次确实发了一条主动消息（用于计数）。
 * deadline：超过这个时间点（ms）才拿到模型回复的，调用方应丢弃不发——调度器已经不等它了（R4）。
 */
export type ProactiveDeliver = (userId: string, deadline: number) => Promise<boolean>;

function cstParts(now: number): { hour: number; date: string } {
  const s = new Date(now).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  // en-CA → "2026-11-04, 23:10"；部分 ICU 版本午夜写成 "24"，取模归一
  const m = s.match(/(\d{4}-\d{2}-\d{2}),?\s+(\d{2})/);
  return { date: m ? m[1]! : '', hour: m ? Number(m[2]) % 24 : 0 };
}

export class ProactiveScheduler {
  private readonly cfg: ProactiveConfig;
  private readonly file: string;
  private readonly deliver: ProactiveDeliver;
  private readonly sessions = new Map<string, ProactiveSession>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public constructor(deliver: ProactiveDeliver, cfg: Partial<ProactiveConfig> = {}, file = DEFAULT_PROACTIVE_FILE) {
    this.deliver = deliver;
    this.cfg = { ...DEFAULT_PROACTIVE_CONFIG, ...cfg };
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { sessions?: ProactiveSession[] };
      for (const s of data.sessions ?? []) if (s && s.userId) this.sessions.set(s.userId, s);
    } catch { /* 损坏则从空开始 */ }
  }

  private save(): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()] }, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* ignore */ }
  }

  private get(userId: string): ProactiveSession {
    let s = this.sessions.get(userId);
    if (!s) {
      s = { userId, enabled: false, lastUserAt: Date.now(), nextAt: 0, unanswered: 0, sentDate: '', sentToday: 0 };
      this.sessions.set(userId, s);
    }
    return s;
  }

  private randomNext(now = Date.now()): number {
    const min = Math.max(1, this.cfg.minMinutes);
    const max = Math.max(min, this.cfg.maxMinutes);
    return now + Math.round((min + Math.random() * (max - min)) * 60_000);
  }

  private inQuiet(hour: number): boolean {
    const { quietStart: a, quietEnd: b } = this.cfg;
    if (a === b) return false;
    return a < b ? hour >= a && hour < b : hour >= a || hour < b;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.tickMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.save();
  }

  /** 用户发来消息：清零未回复、重排下一次（仅对已开通的会话排程）。群聊每条消息都会调，故延迟落盘 */
  public noteUserMessage(userId: string): void {
    const s = this.sessions.get(userId);
    if (!s || !s.enabled) return; // 未开通的会话不建档、不落盘
    s.lastUserAt = Date.now();
    s.unanswered = 0;
    s.nextAt = this.randomNext();
    this.saveSoon();
  }

  private saveTimer: NodeJS.Timeout | null = null;
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 5_000);
    this.saveTimer.unref?.();
  }

  public setEnabled(userId: string, on: boolean): void {
    const s = this.get(userId);
    s.enabled = on;
    s.nextAt = on ? this.randomNext() : 0;
    if (on) s.unanswered = 0;
    this.save();
  }

  public isEnabled(userId: string): boolean {
    return this.sessions.get(userId)?.enabled ?? false;
  }

  public statusText(userId: string): string {
    const s = this.sessions.get(userId);
    if (!s || !s.enabled) return '主动消息：未开通（发 `/proactive on` 开通）';
    const etaMin = s.nextAt ? Math.max(0, Math.round((s.nextAt - Date.now()) / 60_000)) : null;
    return `主动消息：已开通 · 免打扰 ${this.cfg.quietStart}-${this.cfg.quietEnd} 点 · 每天最多 ${this.cfg.maxPerDay} 条`
      + (etaMin !== null ? ` · 下次约 ${etaMin} 分钟后（随机）` : '');
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const { hour, date } = cstParts(now);
      const due: ProactiveSession[] = [];
      for (const s of this.sessions.values()) {
        if (!s.enabled || !s.nextAt || now < s.nextAt) continue;
        if (this.inQuiet(hour)) { s.nextAt = this.randomNext(now); continue; } // 免打扰顺延
        if (s.sentDate !== date) { s.sentDate = date; s.sentToday = 0; }      // 跨天重置
        if (s.sentToday >= this.cfg.maxPerDay) { s.nextAt = this.randomNext(now); continue; }
        if (this.cfg.maxUnanswered > 0 && s.unanswered >= this.cfg.maxUnanswered) { s.nextAt = 0; continue; } // 连续没回，暂停待用户开口
        s.nextAt = this.randomNext(now); // 先排下次，避免 deliver 期间重复触发
        due.push(s);
      }
      this.save();
      // 分批并发投递；每次投递有上限时间，一个卡住的回合不会挡住其他会话（R4）
      for (let i = 0; i < due.length; i += this.cfg.concurrency) {
        await Promise.all(due.slice(i, i + this.cfg.concurrency).map(s => this.deliverOne(s, date)));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async deliverOne(s: ProactiveSession, date: string): Promise<void> {
    const deadline = Date.now() + this.cfg.deliverTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>(r => { timer = setTimeout(() => r(false), this.cfg.deliverTimeoutMs); timer.unref?.(); });
    let sent = false;
    try {
      sent = await Promise.race([this.deliver(s.userId, deadline).catch(() => false), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (sent) { s.unanswered += 1; s.sentToday += 1; s.sentDate = date; this.save(); }
  }
}
