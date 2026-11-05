/**
 * 运行状况自检和告警。
 *
 * 起因：2026-11-05 一天里内核 OOM 杀了 7 次记忆库进程、漏接过消息，管理员只能事后翻日志；
 * 被问起「刚才怎么没回」时，她也只能凭空编原因。这里用程序记录的真实数据回答这些问题：
 *
 * - 每分钟采样：/proc/meminfo 可用内存、/proc/vmstat 的 oom_kill 计数（增加时从内核日志里查出被杀的进程）、
 *   磁盘剩余、负载；
 * - 事件：agy / 记忆库进程意外退出、NapCat 断线和重连、Agent 回合失败/超时、消息发送失败；
 * - 告警：私聊发给管理员（access 里的 admins），同一类 30 分钟内只发一次；北京时间 1–8 点攒着，8 点后合并成一条发；
 *   断线期间的告警等重连后再发；
 * - 记录：~/.dsh-qqbot/diag.json（每分钟覆盖的快照）和 ~/.dsh-qqbot/events.jsonl（事件流水，只有元数据和简短说明，
 *   不含聊天内容），管理员的 agy 和 /diag 命令都读它们。
 *
 * 上次是不是正常退出：启动时看上一份 diag.json 的 clean 标记，不是就记一条告警（多半是被 OOM 或崩溃）。
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { envNumber } from './group-chime.ts';
import { cstFields } from './reminders.ts';

export const DEFAULT_DIAG_FILE = resolve(homedir(), '.dsh-qqbot', 'diag.json');
export const DEFAULT_EVENTS_FILE = resolve(homedir(), '.dsh-qqbot', 'events.jsonl');

export type HealthLevel = 'info' | 'warn' | 'alert';

export interface HealthEvent {
  at: number;
  kind: string;
  level: HealthLevel;
  detail: string;
}

export interface HealthConfig {
  tickMs: number;
  /** 可用内存低于它（MB）告警 */
  lowMemMb: number;
  /** 磁盘剩余低于它（GB）告警 */
  lowDiskGb: number;
  /** 同一类告警的最短间隔 */
  alertCooldownMs: number;
  /** 窗口内回合失败/发送失败达到这个次数告警 */
  burstCount: number;
  burstWindowMs: number;
  /** NapCat 断线超过这么久，重连后告警 */
  wsDownAlertMs: number;
  /** 告警免打扰（北京时间，小时），期间攒着，结束后合并发送 */
  quietStart: number;
  quietEnd: number;
}

export function healthConfigFromEnv(): HealthConfig {
  return {
    tickMs: 60_000,
    lowMemMb: envNumber('NAPCAT_HEALTH_LOW_MEM_MB', 1024, 0, 1 << 20),
    lowDiskGb: envNumber('NAPCAT_HEALTH_LOW_DISK_GB', 2, 0, 1 << 20),
    alertCooldownMs: envNumber('NAPCAT_HEALTH_ALERT_COOLDOWN_MIN', 30, 0, 24 * 60) * 60_000,
    burstCount: envNumber('NAPCAT_HEALTH_BURST_COUNT', 3, 1, 100, true),
    burstWindowMs: 10 * 60_000,
    wsDownAlertMs: envNumber('NAPCAT_HEALTH_WS_DOWN_SEC', 60, 0, 86400) * 1000,
    quietStart: envNumber('NAPCAT_HEALTH_QUIET_START', 1, 0, 23, true),
    quietEnd: envNumber('NAPCAT_HEALTH_QUIET_END', 8, 0, 23, true),
  };
}

/** 发告警：返回 false 表示现在发不了（没连上 NapCat 等），稍后重试 */
export type AlertSender = (text: string) => Promise<boolean>;

const pad = (n: number): string => String(n).padStart(2, '0');
/** 北京时间 HH:MM */
export function hhmm(ms: number): string {
  const f = cstFields(ms);
  return `${pad(f.h)}:${pad(f.mi)}`;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} 分钟`;
  return `${(m / 60).toFixed(1)} 小时`;
}

/** /proc/meminfo 的 MemTotal / MemAvailable（MB）；读不到返回 null */
export function readMem(): { totalMb: number; availMb: number } | null {
  try {
    const t = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t)?.[1] ?? NaN);
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    if (!Number.isFinite(total) || !Number.isFinite(avail)) return null;
    return { totalMb: Math.round(total / 1024), availMb: Math.round(avail / 1024) };
  } catch {
    return null;
  }
}

/** 开机以来内核 OOM 杀进程的次数；读不到返回 null */
export function readOomKills(): number | null {
  try {
    const m = /^oom_kill\s+(\d+)/m.exec(readFileSync('/proc/vmstat', 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** HOME 所在分区剩余空间（GB） */
export function readDiskFreeGb(path = homedir()): number | null {
  try {
    const s = statfsSync(path);
    return Math.round((s.bavail * s.bsize) / 1024 ** 3 * 10) / 10;
  } catch {
    return null;
  }
}

/** 从内核日志里找最近几分钟被 OOM 杀掉的进程（服务用户在 adm 组，能读）。查不到返回空数组 */
export function recentOomVictims(sinceSec = 180): Promise<string[]> {
  return new Promise(res => {
    execFile('journalctl', ['-k', '--since', `-${sinceSec}s`, '-o', 'cat', '--no-pager'], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err && !stdout) { res([]); return; }
      const out: string[] = [];
      for (const m of String(stdout).matchAll(/Killed process (\d+) \(([^)]+)\)[^\n]*?anon-rss:(\d+)kB/g)) {
        out.push(`${m[2]}（pid ${m[1]}，占 ${(Number(m[3]) / 1024 / 1024).toFixed(1)}GB）`);
      }
      res(out);
    });
  });
}

export class HealthMonitor {
  private readonly cfg: HealthConfig;
  private readonly startedAt = Date.now();
  private readonly events: HealthEvent[] = [];
  private readonly lastAlertAt = new Map<string, number>();
  private readonly pending: string[] = [];
  private readonly windows = new Map<string, number[]>();
  private readonly counters = { turnsOk: 0, turnsFailed: 0, sendFailures: 0, wsDowns: 0, agyCrashes: 0, memoryCrashes: 0 };
  private oomAtStart: number | null = readOomKills();
  private lastOom: number | null = this.oomAtStart;
  private wsDownSince: number | null = null;
  private wsConnected = false;
  private lastSample: Record<string, unknown> = {};
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private eventLines = 0;
  private lowMem = false;
  private lowDisk = false;

  public constructor(
    private readonly sendAlert: AlertSender,
    /** 适配器提供的额外状态（进程数、提醒数等），写进 diag.json 和 /diag */
    private readonly extra: () => Record<string, unknown> = () => ({}),
    private readonly diagFile: string | null = DEFAULT_DIAG_FILE,
    private readonly eventsFile: string | null = DEFAULT_EVENTS_FILE,
    cfg: Partial<HealthConfig> = {},
  ) {
    this.cfg = { ...healthConfigFromEnv(), ...cfg };
    this.loadEvents();
    this.checkPreviousRun();
  }

  // ───────────── 记录 ─────────────

  private loadEvents(): void {
    if (!this.eventsFile || !existsSync(this.eventsFile)) return;
    try {
      const lines = readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean);
      this.eventLines = lines.length;
      for (const l of lines.slice(-200)) {
        try {
          const e = JSON.parse(l) as HealthEvent;
          if (e && typeof e.at === 'number' && e.kind) this.events.push(e);
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* ignore */ }
  }

  private appendEvent(e: HealthEvent): void {
    if (!this.eventsFile) return;
    try {
      const dir = dirname(this.eventsFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.eventsFile, JSON.stringify(e) + '\n', { encoding: 'utf8', mode: 0o600 });
      this.eventLines++;
      if (this.eventLines > 2000) {
        // 环形：只留最近 1000 条
        const lines = readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).slice(-1000);
        const tmp = `${this.eventsFile}.${process.pid}.tmp`;
        writeFileSync(tmp, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, this.eventsFile);
        this.eventLines = lines.length;
      }
    } catch { /* ignore */ }
  }

  /** 记一条事件；level=alert 会按冷却给管理员发告警 */
  public event(kind: string, detail: string, level: HealthLevel = 'info', alertText?: string): void {
    const e: HealthEvent = { at: Date.now(), kind, level, detail: detail.replace(/\s+/g, ' ').slice(0, 300) };
    this.events.push(e);
    while (this.events.length > 200) this.events.shift();
    this.appendEvent(e);
    if (level !== 'info') console.warn(`[Health] ${level} ${kind}: ${e.detail}`);
    if (level === 'alert') this.alert(kind, alertText ?? e.detail);
  }

  private alert(kind: string, text: string): void {
    const now = Date.now();
    const last = this.lastAlertAt.get(kind) ?? 0;
    if (now - last < this.cfg.alertCooldownMs) return;
    this.lastAlertAt.set(kind, now);
    this.pending.push(`${hhmm(now)} ${text}`);
    void this.flushAlerts();
  }

  private inQuiet(now = Date.now()): boolean {
    const { quietStart: a, quietEnd: b } = this.cfg;
    if (a === b) return false;
    const h = cstFields(now).h;
    return a < b ? h >= a && h < b : h >= a || h < b;
  }

  /** 把攒着的告警合并成一条发出去（免打扰时段、断线时不发） */
  public async flushAlerts(): Promise<void> {
    if (this.flushing || this.pending.length === 0 || this.inQuiet() || !this.wsConnected) return;
    this.flushing = true;
    try {
      const items = this.pending.splice(0, 20);
      const text = `⚠️ 哈Gemi 运行告警\n${items.map(i => `- ${i}`).join('\n')}\n（/diag 看详细状态）`;
      let ok = false;
      try { ok = await this.sendAlert(text); } catch { ok = false; }
      if (!ok) this.pending.unshift(...items);
    } finally {
      this.flushing = false;
    }
  }

  /** 窗口内同类事件计数，达到阈值返回 true（触发后清零，避免每条都触发） */
  private burst(kind: string): boolean {
    const now = Date.now();
    const arr = (this.windows.get(kind) ?? []).filter(t => now - t < this.cfg.burstWindowMs);
    arr.push(now);
    if (arr.length >= this.cfg.burstCount) {
      this.windows.set(kind, []);
      return true;
    }
    this.windows.set(kind, arr);
    return false;
  }

  // ───────────── 适配器上报的事件 ─────────────

  public noteTurnOk(): void {
    this.counters.turnsOk++;
  }

  /** Agent 回合失败（超时、进程崩溃、agy 报错）。detail 只放错误类型和简短说明，不放聊天内容 */
  public noteTurnFailure(where: string, detail: string): void {
    this.counters.turnsFailed++;
    const hot = this.burst('turn_failed');
    this.event('turn_failed', `${where}: ${detail}`, hot ? 'alert' : 'warn',
      hot ? `${Math.round(this.cfg.burstWindowMs / 60_000)} 分钟内 Agent 回合失败 ${this.cfg.burstCount} 次以上，最近一次：${detail.slice(0, 120)}` : undefined);
  }

  /** 消息发送失败（重试用尽） */
  public noteSendFailure(where: string, detail: string): void {
    this.counters.sendFailures++;
    const hot = this.burst('send_failed');
    this.event('send_failed', `${where}: ${detail}`, hot ? 'alert' : 'warn',
      hot ? `${Math.round(this.cfg.burstWindowMs / 60_000)} 分钟内消息发送失败 ${this.cfg.burstCount} 次以上（可能被风控或网络不通），最近一次：${detail.slice(0, 120)}` : undefined);
  }

  /** agy 进程退出。expected = 我们自己结束的（空闲回收、超时打断、/clear） */
  public noteAgyExit(tier: string, sessionKey: string, code: number | null, signal: string | null, expected: boolean): void {
    if (expected) return;
    this.counters.agyCrashes++;
    const killed = signal === 'SIGKILL';
    this.event('agy_exit', `${tier} ${sessionKey} code=${code} signal=${signal}`, killed ? 'alert' : 'warn',
      killed ? `${tier} 档的 agy 进程被强制结束（SIGKILL，多半是内存不足被系统杀掉）` : undefined);
  }

  /** 记忆库（MemoryOS）进程退出 */
  public noteMemoryExit(code: number | null, signal: string | null, expected: boolean): void {
    if (expected) return;
    this.counters.memoryCrashes++;
    const killed = signal === 'SIGKILL';
    this.event('memoryos_exit', `code=${code} signal=${signal}`, 'alert',
      killed ? '记忆库进程被强制结束（SIGKILL，多半是内存不足被系统杀掉），下一条消息会自动重新拉起' : `记忆库进程意外退出（code=${code}），下一条消息会自动重新拉起`);
  }

  public noteWsDown(code?: number | string): void {
    if (!this.wsConnected && this.wsDownSince !== null) return;
    this.wsConnected = false;
    this.wsDownSince = Date.now();
    this.counters.wsDowns++;
    this.event('ws_down', `NapCat 连接断开 code=${code ?? 'N/A'}`, 'warn');
  }

  public noteWsUp(): void {
    const since = this.wsDownSince;
    this.wsConnected = true;
    this.wsDownSince = null;
    if (since !== null) {
      const dur = Date.now() - since;
      const long = dur >= this.cfg.wsDownAlertMs;
      this.event('ws_up', `NapCat 重新连上，断了 ${fmtDuration(dur)}`, long ? 'alert' : 'info',
        long ? `NapCat 断线 ${fmtDuration(dur)}（${hhmm(since)} 起），已重新连上；期间的消息可能没收到` : undefined);
    }
    void this.flushAlerts();
  }

  private checkPreviousRun(): void {
    if (!this.diagFile || !existsSync(this.diagFile)) return;
    try {
      const d = JSON.parse(readFileSync(this.diagFile, 'utf8')) as { pid?: number; clean?: boolean; heartbeatAt?: number };
      if (d.clean === false && d.pid !== process.pid) {
        const hb = typeof d.heartbeatAt === 'number' ? hhmm(d.heartbeatAt) : '未知';
        this.event('unclean_exit', `上次运行（pid ${d.pid}）没有正常退出，最后心跳 ${hb}`, 'alert',
          `机器人上次没有正常退出（最后心跳 ${hb}），可能是崩溃或被系统杀掉，已自动重启`);
      }
    } catch { /* ignore */ }
  }

  // ───────────── 采样 ─────────────

  public start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.tickMs);
    this.timer.unref?.();
  }

  /** clean=true 表示正常停机，写进 diag.json，下次启动据此判断 */
  public stop(clean = true): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.writeDiag(clean);
  }

  private async tick(): Promise<void> {
    const mem = readMem();
    const oom = readOomKills();
    const disk = readDiskFreeGb();
    this.lastSample = { mem, oomKillsSinceBoot: oom, diskFreeGb: disk, load: loadavg().map(n => Math.round(n * 100) / 100) };

    if (mem && this.cfg.lowMemMb > 0) {
      const low = mem.availMb < this.cfg.lowMemMb;
      if (low && !this.lowMem) this.event('low_memory', `可用内存 ${mem.availMb}MB / ${mem.totalMb}MB`, 'alert', `服务器可用内存只剩 ${mem.availMb}MB（共 ${mem.totalMb}MB），再涨可能触发 OOM`);
      else if (!low && this.lowMem) this.event('memory_ok', `可用内存回到 ${mem.availMb}MB`, 'info');
      this.lowMem = low;
    }
    if (disk !== null && this.cfg.lowDiskGb > 0) {
      const low = disk < this.cfg.lowDiskGb;
      if (low && !this.lowDisk) this.event('low_disk', `磁盘剩余 ${disk}GB`, 'alert', `磁盘只剩 ${disk}GB`);
      this.lowDisk = low;
    }
    if (oom !== null && this.lastOom !== null && oom > this.lastOom) {
      const n = oom - this.lastOom;
      const victims = await recentOomVictims(Math.ceil(this.cfg.tickMs / 1000) + 120);
      const who = victims.length ? `：${victims.join('、')}` : '';
      this.event('oom_kill', `内核 OOM 杀了 ${n} 个进程${who}`, 'alert', `内存耗尽，系统杀掉了 ${n} 个进程${who}`);
    }
    if (oom !== null) this.lastOom = oom;
    if (this.oomAtStart === null) this.oomAtStart = oom;

    this.writeDiag(false);
    void this.flushAlerts();
  }

  private snapshot(clean: boolean): Record<string, unknown> {
    return {
      pid: process.pid,
      clean,
      startedAt: this.startedAt,
      heartbeatAt: Date.now(),
      heartbeatCst: hhmm(Date.now()),
      ...this.lastSample,
      oomKillsSinceStart: this.lastOom !== null && this.oomAtStart !== null ? this.lastOom - this.oomAtStart : null,
      napcat: { connected: this.wsConnected, downSince: this.wsDownSince },
      counters: { ...this.counters },
      pendingAlerts: this.pending.length,
      ...this.extra(),
      recentEvents: this.events.slice(-15),
    };
  }

  private writeDiag(clean: boolean): void {
    if (!this.diagFile) return;
    try {
      const dir = dirname(this.diagFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.diagFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(clean), null, 1), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.diagFile);
    } catch { /* ignore */ }
  }

  // ───────────── 给人看 ─────────────

  /** /diag 的文字版 */
  public diagText(): string {
    const s = this.snapshot(false);
    const mem = s.mem as { totalMb: number; availMb: number } | null;
    const ex = this.extra();
    const upMs = Date.now() - this.startedAt;
    const lines = [
      '🩺 运行状况',
      `- 已运行 ${fmtDuration(upMs)}（${hhmm(this.startedAt)} 启动）`,
      `- 内存：可用 ${mem ? `${(mem.availMb / 1024).toFixed(1)}GB / ${(mem.totalMb / 1024).toFixed(1)}GB` : '读不到'}；负载 ${(s.load as number[] | undefined)?.join(' ') ?? '?'}；磁盘剩余 ${s.diskFreeGb ?? '?'}GB`,
      `- OOM：开机以来 ${s.oomKillsSinceBoot ?? '?'} 次，本次运行以来 ${s.oomKillsSinceStart ?? '?'} 次`,
      `- NapCat：${this.wsConnected ? '已连接' : `断开中（${this.wsDownSince ? hhmm(this.wsDownSince) : '?'} 起）`}，本次运行断过 ${this.counters.wsDowns} 次`,
      `- 回合：成功 ${this.counters.turnsOk}，失败 ${this.counters.turnsFailed}；发送失败 ${this.counters.sendFailures}；agy 意外退出 ${this.counters.agyCrashes}，记忆库意外退出 ${this.counters.memoryCrashes}`,
    ];
    for (const [k, v] of Object.entries(ex)) lines.push(`- ${k}：${typeof v === 'string' ? v : JSON.stringify(v)}`);
    const recent = this.events.filter(e => e.level !== 'info').slice(-8);
    lines.push(recent.length ? '最近的异常：' : '最近没有异常记录。');
    for (const e of recent) lines.push(`  ${hhmm(e.at)} [${e.kind}] ${e.detail.slice(0, 120)}`);
    if (this.pending.length) lines.push(`（还有 ${this.pending.length} 条告警等着发）`);
    return lines.join('\n');
  }

  /**
   * 最近一段时间的异常摘要（给管理员私聊的提示词用）。没有异常返回空串。
   * 只放程序记录的事实，让她被问到「刚才怎么了」时有据可依。
   */
  public recentSummary(withinMs = 30 * 60_000, max = 6): string {
    const cutoff = Date.now() - withinMs;
    const recent = this.events.filter(e => e.at >= cutoff && e.level !== 'info').slice(-max);
    if (recent.length === 0) return '';
    return recent.map(e => `${hhmm(e.at)} ${e.detail.slice(0, 100)}`).join('；');
  }
}
