/**
 * 每日一图：开通的群（或私聊）每天到点推一张 Pixiv 日榜插画。
 *
 * - 群里由群主/群管理员或机器人管理员 `/daily on [HH:MM]` 开通，私聊自己开通；默认 12:00（北京时间，
 *   Pixiv 日榜大约 11:00 更新）；
 * - 到点后 3 小时内补推（机器人那会儿在重启也不会错过），超过就当天不推了；
 * - 选图、合规过滤、偏好、已发去重都在 PixivService.pickRanking 里；本模块只管「什么时候、给谁」。
 * 状态存 ~/.dsh-qqbot/daily-push.json（0600）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { cstDate, cstFields } from './reminders.ts';

export const DEFAULT_DAILY_FILE = resolve(homedir(), '.dsh-qqbot', 'daily-push.json');
export const DEFAULT_DAILY_TIME = '12:00';
/** 到点后多久内还补推 */
const CATCH_UP_MINUTES = 180;
/** 每天每个会话最多尝试几次（网络失败等） */
const MAX_ATTEMPTS_PER_DAY = 3;

export interface DailySub {
  scope: 'c2c' | 'group';
  targetId: string;
  enabled: boolean;
  /** 北京时间 HH:MM */
  time: string;
  /** 最近一次推送（或判定当天不推）的北京日期 */
  lastDate: string;
  setBy: string;
  updatedAt: number;
}

/** 推送结果：sent 推了；skip 今天没有可推的（榜单都发过了等），当天不再试；retry 暂时失败，稍后再试 */
export type DailyPushResult = 'sent' | 'skip' | 'retry';
export type DailyPusher = (sub: DailySub, date: string) => Promise<DailyPushResult>;

/** 「12:30」「9点」「9」「21:05」→ HH:MM；不合法返回 null */
export function normalizeDailyTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{1,2})(?:[:：点时](\d{1,2})?分?)?$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

const keyOf = (scope: 'c2c' | 'group', targetId: string): string => `${scope}:${targetId}`;

export class DailyPushScheduler {
  private readonly subs = new Map<string, DailySub>();
  private readonly attempts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  public constructor(private readonly push: DailyPusher, private readonly file: string | null = DEFAULT_DAILY_FILE) {
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as { subs?: DailySub[] };
      for (const s of d.subs ?? []) {
        if (s && (s.scope === 'c2c' || s.scope === 'group') && /^[A-Za-z0-9_-]{1,64}$/.test(String(s.targetId)) && normalizeDailyTime(s.time)) {
          this.subs.set(keyOf(s.scope, String(s.targetId)), { ...s, targetId: String(s.targetId) });
        }
      }
    } catch (err) {
      console.warn('[DailyPush] daily-push.json 读取失败，从空开始:', err instanceof Error ? err.message : err);
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ subs: [...this.subs.values()] }, null, 1), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[DailyPush] save failed:', err instanceof Error ? err.message : err);
    }
  }

  public get(scope: 'c2c' | 'group', targetId: string): DailySub | undefined {
    return this.subs.get(keyOf(scope, targetId));
  }

  public enabledCount(): number {
    let n = 0;
    for (const s of this.subs.values()) if (s.enabled) n++;
    return n;
  }

  /**
   * 开/关。开通时如果今天的推送时间已经过了，今天就不补推了（从明天开始），免得一开通马上刷一张。
   */
  public set(scope: 'c2c' | 'group', targetId: string, enabled: boolean, by: string, time?: string, now = Date.now()): DailySub {
    const key = keyOf(scope, targetId);
    const prev = this.subs.get(key);
    const t = normalizeDailyTime(time) ?? prev?.time ?? DEFAULT_DAILY_TIME;
    const today = cstDate(now);
    const f = cstFields(now);
    const [h, mi] = t.split(':').map(Number) as [number, number];
    const passed = f.h * 60 + f.mi >= h * 60 + mi;
    const sub: DailySub = {
      scope, targetId, enabled, time: t,
      lastDate: enabled && passed && (!prev?.enabled || prev.time !== t) ? today : (prev?.lastDate ?? ''),
      setBy: by, updatedAt: now,
    };
    this.subs.set(key, sub);
    this.save();
    return sub;
  }

  /** 记一笔「今天已推」（手动 /daily now 之后调用，避免同一天再自动推一次） */
  public markPushed(scope: 'c2c' | 'group', targetId: string, now = Date.now()): void {
    const s = this.subs.get(keyOf(scope, targetId));
    if (!s) return;
    s.lastDate = cstDate(now);
    this.save();
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref?.();
    setTimeout(() => { void this.tick(); }, 15_000).unref?.();
  }

  public stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.save();
  }

  /** 到点的逐个推送。public 便于测试 */
  public async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const today = cstDate(now);
      const f = cstFields(now);
      const minuteNow = f.h * 60 + f.mi;
      for (const s of this.subs.values()) {
        if (!s.enabled || s.lastDate === today) continue;
        const [h, mi] = s.time.split(':').map(Number) as [number, number];
        const due = h * 60 + mi;
        if (minuteNow < due) continue;
        const attemptKey = `${keyOf(s.scope, s.targetId)}|${today}`;
        if (minuteNow > due + CATCH_UP_MINUTES || (this.attempts.get(attemptKey) ?? 0) >= MAX_ATTEMPTS_PER_DAY) {
          s.lastDate = today; // 错过了或试够了，今天不推了
          this.save();
          continue;
        }
        this.attempts.set(attemptKey, (this.attempts.get(attemptKey) ?? 0) + 1);
        let res: DailyPushResult;
        try {
          res = await this.push(s, today);
        } catch (err) {
          console.warn(`[DailyPush] ${s.scope}:${s.targetId} failed:`, err instanceof Error ? err.message : err);
          res = 'retry';
        }
        if (res !== 'retry') {
          s.lastDate = today;
          this.save();
        }
      }
      if (this.attempts.size > 500) this.attempts.clear();
    } finally {
      this.ticking = false;
    }
  }
}
