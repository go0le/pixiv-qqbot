/**
 * 分会话独立去重历史记录器 (Per-Chat Deduplication v3.0 - Claude Opus 4.6 审查加固版)
 *
 * 核心机制与加固：
 * 1. FIFO 环形窗口 (默认上限 500 条)
 * 2. 基于 AsyncMutex 的并发安全访问
 * 3. POSIX 原子写入 (tmp + rename) 与 backup 回退容灾
 * 4. 异常时自动清理未完成的 .tmp 临时文件，避免磁盘垃圾残留 (P1-06)
 * 5. 防频繁写盘阻塞：引入 Dirty Flag + Debounce 批量刷盘 (P1-02)
 * 6. 支持 flushSync() 优雅停机强制落盘 (P1-05)
 * 7. 120 秒防循环重置冷却锁
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { AsyncMutex } from './mutex.ts';

/** 单会话历史容量上限 */
export const MAX_HISTORY_PER_CHAT = 500;

/** 默认持久化文件路径 */
export const DEFAULT_HISTORY_FILE = process.env.PIXIV_HISTORY_FILE
  ? resolve(process.env.PIXIV_HISTORY_FILE)
  : resolve(homedir(), '.dsh-qqbot', 'pixiv_history.json');

/** 历史重置默认冷却时间（毫秒） */
export const DEFAULT_RESET_COOLDOWN_MS = 120_000;

export class PixivHistoryManager {
  private readonly filePath: string;
  private readonly backupFilePath: string;
  private readonly maxPerChat: number;
  private historyMap: Map<string, string[]> = new Map();
  private lastResetMap: Map<string, number> = new Map();
  /** 上次读/写磁盘文件时的 mtime。多个进程（napcat 适配器、各 agy 会话的 MCP）可以共用同一个历史文件 */
  private lastDiskMtimeMs = 0;
  private readonly mutex = new AsyncMutex();

  // 脏标记与防抖刷盘控制 (P1-02)
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(filePath = DEFAULT_HISTORY_FILE, maxPerChat = MAX_HISTORY_PER_CHAT) {
    this.filePath = filePath;
    this.backupFilePath = `${filePath}.bak`;
    this.maxPerChat = maxPerChat;
    this.load();
  }

  /**
   * 从磁盘加载历史数据（支持 backup 自动容灾恢复）
   */
  public load(): void {
    if (this.tryLoadFile(this.filePath)) {
      return;
    }
    // 主文件损坏或不存在，尝试读取备份
    if (this.tryLoadFile(this.backupFilePath)) {
      try {
        this.saveSync();
      } catch {
        // ignore
      }
      return;
    }
    this.historyMap.clear();
  }

  private tryLoadFile(targetPath: string): boolean {
    if (!existsSync(targetPath)) {
      return false;
    }
    try {
      const raw = readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        return false;
      }
      this.historyMap.clear();
      for (const [key, val] of Object.entries(parsed)) {
        if (Array.isArray(val)) {
          this.historyMap.set(key, val.map(String).slice(-this.maxPerChat));
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 把磁盘文件里别的进程写入的记录并进内存（并集，文件里的顺序在前）。
   * 文件没变化（mtime 相同）时什么都不做。
   */
  private mergeFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const mtime = statSync(this.filePath).mtimeMs;
      if (mtime === this.lastDiskMtimeMs) return;
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [key, val] of Object.entries(parsed)) {
        if (!Array.isArray(val)) continue;
        const fromDisk = val.map(String);
        const mine = this.historyMap.get(key) ?? [];
        const seen = new Set(fromDisk);
        const merged = [...fromDisk, ...mine.filter(p => !seen.has(p))];
        this.historyMap.set(key, merged.slice(-this.maxPerChat));
      }
      this.lastDiskMtimeMs = mtime;
    } catch {
      // 文件正在被别的进程写入或损坏：沿用内存数据
    }
  }

  /**
   * 原子化落盘保存历史数据至磁盘 (tmp -> rename + backup)
   * 包含完善的 tmp 异常清理保护 (P1-06)
   */
  public saveSync(merge = true): void {
    let tmpPath = '';
    try {
      if (merge) this.mergeFromDisk();
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 如果当前主文件存在，先创建备份
      if (existsSync(this.filePath)) {
        try {
          copyFileSync(this.filePath, this.backupFilePath);
        } catch {
          // ignore backup failure
        }
      }

      const plainObject: Record<string, string[]> = {};
      for (const [key, pids] of this.historyMap.entries()) {
        plainObject[key] = pids;
      }
      const serialized = JSON.stringify(plainObject, null, 2);

      tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, this.filePath);
      this.dirty = false;
      try { this.lastDiskMtimeMs = statSync(this.filePath).mtimeMs; } catch { /* ignore */ }
    } catch (err) {
      if (tmpPath && existsSync(tmpPath)) {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      // 写入失败降级忽略
    }
  }

  /**
   * 标记脏数据并安排防抖刷盘 (默认 1 秒合并)
   */
  public markDirty(debounceMs = 1000): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.dirty) {
          this.saveSync();
        }
      }, debounceMs);
    }
  }

  /**
   * 强制立即同步刷盘（用于测试或进程退出信号时）
   */
  public flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.saveSync();
  }

  /**
   * 异步安全保存
   */
  public async save(): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.flushSync();
    });
  }

  /**
   * 查询某个会话是否已发送过特定 PID
   */
  public has(chatKey: string, pid: string): boolean {
    this.mergeFromDisk();
    const list = this.historyMap.get(chatKey);
    if (!list) return false;
    return list.includes(String(pid));
  }

  public hasSent(chatKey: string, pid: string): boolean {
    return this.has(chatKey, pid);
  }

  /**
   * 获取某个会话已发送的 PID 列表副本
   */
  public get(chatKey: string): string[] {
    this.mergeFromDisk();
    const list = this.historyMap.get(chatKey);
    return list ? [...list] : [];
  }

  public getSentPids(chatKey: string): string[] {
    return this.get(chatKey);
  }

  /**
   * 记录新增已发送的 PID (单条或批量)
   * 超过 maxPerChat 时自动遵循 FIFO 丢弃最老记录
   */
  public record(chatKey: string, pids: string | string[]): void {
    const list = this.historyMap.get(chatKey) ?? [];
    const incoming = Array.isArray(pids) ? pids : [pids];

    for (const pid of incoming) {
      const strPid = String(pid);
      const existingIdx = list.indexOf(strPid);
      if (existingIdx !== -1) {
        list.splice(existingIdx, 1);
      }
      list.push(strPid);
    }

    if (list.length > this.maxPerChat) {
      list.splice(0, list.length - this.maxPerChat);
    }

    this.historyMap.set(chatKey, list);
    this.markDirty();
  }

  public recordSent(chatKey: string, pids: string | string[]): void {
    this.record(chatKey, pids);
  }

  /**
   * 异步互斥记录已发送 PID
   */
  public async recordSentAsync(chatKey: string, pids: string | string[]): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.record(chatKey, pids);
    });
  }

  /**
   * 判断指定会话当前是否允许执行耗尽重置（防循环频繁刷屏）
   */
  public canReset(chatKey: string, cooldownMs = DEFAULT_RESET_COOLDOWN_MS, now = Date.now()): boolean {
    const lastReset = this.lastResetMap.get(chatKey) ?? 0;
    return (now - lastReset) >= cooldownMs;
  }

  /**
   * 清除指定会话的历史记录 (耗尽兜底重置)
   */
  public clear(chatKey: string, now = Date.now()): void {
    this.mergeFromDisk();
    if (this.historyMap.has(chatKey)) {
      this.historyMap.delete(chatKey);
      this.saveSync(false); // 不能再并回磁盘内容，否则刚清掉的记录会被复活
    }
    this.lastResetMap.set(chatKey, now);
  }

  /**
   * 只让指定的 PID 重新变为「未发送」，保留该会话其它记录。用于某个检索范围发完后的耗尽重置，
   * 避免一次搜空就把整个群的去重历史清掉。
   */
  public forget(chatKey: string, pids: string[], now = Date.now()): void {
    this.mergeFromDisk();
    const list = this.historyMap.get(chatKey);
    if (list && pids.length > 0) {
      const drop = new Set(pids.map(String));
      const kept = list.filter(p => !drop.has(p));
      if (kept.length !== list.length) {
        this.historyMap.set(chatKey, kept);
        this.saveSync(false);
      }
    }
    this.lastResetMap.set(chatKey, now);
  }

  public clearChat(chatKey: string, now = Date.now()): void {
    this.clear(chatKey, now);
  }

  /**
   * 获取所有会话历史数据 (用于调试与测试)
   */
  public getAll(): Record<string, string[]> {
    const obj: Record<string, string[]> = {};
    for (const [key, val] of this.historyMap.entries()) {
      obj[key] = [...val];
    }
    return obj;
  }
}

/** 全局单例历史记录器 */
export const defaultPixivHistory = new PixivHistoryManager();
