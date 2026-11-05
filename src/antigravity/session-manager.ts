/**
 * Antigravity Session Manager
 *
 * Manages conversation instances across QQ peer targets (C2C users, group chats).
 * Features:
 * - Lazy process instantiation
 * - Conversation resume across restarts: persists epoch + the conversation ID agy actually assigned (agy ignores unknown --conversation IDs)
 * - Reset support (/clear, /reset) with epoch bumps
 * - Automatic idle process reaping to preserve memory
 * - Turn queueing to prevent interleaved prompts
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AntigravityConfig } from './types.ts';
import { deriveConversationId, buildSessionKey } from './session-id.ts';
import { AntigravityProcess, AgyBlockedToolError, type ProcessTurnCallbacks } from './process.ts';

/** 模型调用了会挂起整轮的工具（如 schedule）被打断后，续接同一个会话时发给它的说明 */
const BLOCKED_TOOL_NOTICE = (tool: string): string =>
  `[系统提示，不是用户发的] 你刚才调用的 ${tool} 工具在 QQ 机器人里不能用：它会让这一轮一直挂着，期间用户发来的新消息都收不到，程序已经把它取消了，以后也不要再用。`
  + '需要定时提醒用户时，在回复里写提醒标记 `[提醒:YYYY-MM-DD HH:MM|提醒内容]`（北京时间），程序会到点提醒；服务器上的定时任务（仅管理员）改用 `systemd-run --on-calendar=...`。没有执行命令的权限就如实告诉用户做不了。'
  + '然后像平常一样直接回复用户刚才那条消息，不要提到这条系统提示。';

/** 一轮结束了却没有任何回复文字（常见原因：工具没有权限被自动拒绝，agy 直接结束本轮）时，追问一次 */
const EMPTY_REPLY_NUDGE = '[系统提示，不是用户发的] 上一步没有产生任何回复文字（可能是某个工具没有权限、被自动拒绝了）。'
  + '请直接用文字回复用户刚才那条消息；做不到的事如实说明。不要提到这条系统提示。';

export interface AntigravitySession {
  readonly sessionKey: string;
  readonly scope: 'c2c' | 'group';
  readonly targetId: string;
  readonly userId?: string;
  epoch: number;
  conversationId: string;
  /** agy 实际分配的会话 ID（agy 会忽略本地不存在的 --conversation 并自己新建）；有就优先用它续接 */
  agyConversationId?: string;
  busy: boolean;
  process: AntigravityProcess | null;
  lastActiveAt: number;
  queue: Array<{
    prompt: string;
    callbacks?: ProcessTurnCallbacks;
    resolve: (res: any) => void;
    reject: (err: any) => void;
  }>;
}

/** 持久化的会话状态：每个 sessionKey 的 epoch 和 agy 真实会话 ID，重启后据此续接上下文、保留 /clear 的效果 */
interface PersistedSession {
  epoch: number;
  agyId?: string;
}

export class AntigravitySessionManager {
  private readonly sessions = new Map<string, AntigravitySession>();
  private readonly config: AntigravityConfig;
  private readonly groupScope: 'user' | 'group';
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly stateFile: string | null;
  private readonly persisted = new Map<string, PersistedSession>();
  /** agy 进程退出时回调（运行状况自检用）。expected = 我们自己结束的 */
  public onProcessExit: ((info: { sessionKey: string; code: number | null; signal: string | null; expected: boolean }) => void) | null = null;

  /**
   * @param stateFile 会话状态文件（每个 agy HOME 一份，因为会话 ID 只在对应 HOME 里有效）。不传则不持久化。
   */
  public constructor(
    config: AntigravityConfig = {},
    groupScope: 'user' | 'group' = 'user',
    stateFile: string | null = null,
  ) {
    this.config = config;
    this.groupScope = groupScope;
    this.stateFile = stateFile;
    this.loadState();
    this.startIdleSweep();
  }

  private loadState(): void {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const d = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Record<string, PersistedSession>;
      for (const [k, v] of Object.entries(d)) {
        if (v && Number.isInteger(v.epoch) && v.epoch >= 0) this.persisted.set(k, { epoch: v.epoch, agyId: typeof v.agyId === 'string' ? v.agyId : undefined });
      }
    } catch (err) {
      console.warn('[AntigravitySessionManager] state file unreadable, starting fresh:', err instanceof Error ? err.message : err);
    }
  }

  private saveState(): void {
    if (!this.stateFile) return;
    try {
      const dir = dirname(this.stateFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.persisted), null, 1), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch (err) {
      console.warn('[AntigravitySessionManager] state save failed:', err instanceof Error ? err.message : err);
    }
  }

  private remember(session: AntigravitySession): void {
    this.persisted.set(session.sessionKey, { epoch: session.epoch, agyId: session.agyConversationId });
    this.saveState();
  }

  public getSessionCount(): number {
    return this.sessions.size;
  }

  public getActiveProcessCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.process?.isRunning) {
        count++;
      }
    }
    return count;
  }

  public getSessionKey(scope: 'c2c' | 'group', targetId: string, userId?: string): string {
    return buildSessionKey(scope, targetId, userId, this.groupScope);
  }

  public getOrCreateSession(
    scope: 'c2c' | 'group',
    targetId: string,
    userId?: string,
  ): AntigravitySession {
    const key = this.getSessionKey(scope, targetId, userId);
    let session = this.sessions.get(key);

    if (!session) {
      const saved = this.persisted.get(key);
      const epoch = saved?.epoch ?? 0;
      const conversationId = deriveConversationId(key, epoch);
      session = {
        sessionKey: key,
        scope,
        targetId,
        userId,
        epoch,
        conversationId,
        agyConversationId: saved?.agyId,
        busy: false,
        process: null,
        lastActiveAt: Date.now(),
        queue: [],
      };
      this.sessions.set(key, session);
    }

    return session;
  }

  public getProcess(session: AntigravitySession): AntigravityProcess {
    session.lastActiveAt = Date.now();
    if (!session.process) {
      const proc = new AntigravityProcess(session.agyConversationId ?? session.conversationId, this.config);
      proc.on('conversation', (id: string) => {
        // 进程可能已被 reset 替换掉；只接受当前进程的上报
        if (session.process !== proc || session.agyConversationId === id) return;
        session.agyConversationId = id;
        this.remember(session);
      });
      proc.on('exit', (code: number | null, signal: string | null, expected: boolean) => {
        try {
          this.onProcessExit?.({ sessionKey: session.sessionKey, code, signal, expected: Boolean(expected) });
        } catch { /* 自检回调出错不影响会话 */ }
      });
      session.process = proc;
    }
    return session.process;
  }

  /**
   * Resets the conversation context for this peer.
   * Gracefully terminates any active process, bumps the epoch, and derives a fresh conversation ID.
   */
  public async resetSession(
    scope: 'c2c' | 'group',
    targetId: string,
    userId?: string,
  ): Promise<AntigravitySession> {
    const session = this.getOrCreateSession(scope, targetId, userId);

    if (session.process) {
      await session.process.terminate();
      session.process = null;
    }

    // Clear any queued messages
    while (session.queue.length > 0) {
      const item = session.queue.shift();
      item?.reject(new Error('Session was reset by user'));
    }

    session.busy = false;
    session.epoch += 1;
    session.conversationId = deriveConversationId(session.sessionKey, session.epoch);
    session.agyConversationId = undefined;
    session.lastActiveAt = Date.now();
    this.remember(session);

    return session;
  }

  /**
   * Enqueues or immediately executes a user turn.
   */
  public async executeTurn(
    scope: 'c2c' | 'group',
    targetId: string,
    userId: string | undefined,
    prompt: string,
    callbacks?: ProcessTurnCallbacks,
  ): Promise<string> {
    const session = this.getOrCreateSession(scope, targetId, userId);

    if (session.busy) {
      // Turn is in progress, enqueue
      return new Promise<string>((resolve, reject) => {
        session.queue.push({
          prompt,
          callbacks,
          resolve,
          reject,
        });
      });
    }

    session.busy = true;
    return this.runTurn(session, prompt, callbacks);
  }

  private async runTurn(
    session: AntigravitySession,
    prompt: string,
    callbacks?: ProcessTurnCallbacks,
  ): Promise<string> {
    const proc = this.getProcess(session);
    session.lastActiveAt = Date.now();
    try {
      let result;
      try {
        result = await proc.sendUserMessage(prompt, callbacks);
      } catch (err) {
        if (!(err instanceof AgyBlockedToolError)) throw err;
        // 进程已被打断；同一个对象会等旧进程退干净、用 agy 会话 ID 起新进程续接上下文，只重试一次
        console.warn(`[AntigravitySessionManager] ${session.sessionKey}: ${err.message}; resuming with a notice`);
        result = await this.getProcess(session).sendUserMessage(BLOCKED_TOOL_NOTICE(err.tool), callbacks);
        if (err.partialText.trim() && !result.response.includes(err.partialText.trim())) {
          result.response = `${err.partialText.trim()}\n${result.response}`;
        }
      }
      if (!result.response.trim()) {
        console.warn(`[AntigravitySessionManager] ${session.sessionKey}: turn ended with no reply text, nudging once`);
        result = await this.getProcess(session).sendUserMessage(EMPTY_REPLY_NUDGE, callbacks);
      }
      session.lastActiveAt = Date.now();
      return result.response;
    } finally {
      this.drainQueue(session);
    }
  }

  private drainQueue(session: AntigravitySession): void {
    if (session.queue.length === 0) {
      session.busy = false;
      return;
    }
    const next = session.queue.shift();
    if (!next) {
      session.busy = false;
      return;
    }

    this.runTurn(session, next.prompt, next.callbacks)
      .then(next.resolve)
      .catch(next.reject);
  }

  private startIdleSweep(): void {
    // Check every 60 seconds
    this.sweepTimer = setInterval(() => {
      this.sweepIdleSessions();
    }, 60000);
    this.sweepTimer.unref?.();
  }

  /**
   * Terminates processes that have been idle past idleTimeoutMs.
   * Conversation ID is kept so subsequent messages resume cleanly.
   */
  public sweepIdleSessions(): void {
    const idleTimeout = this.config.idleTimeoutMs ?? 15 * 60 * 1000;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (session.process && session.process.isRunning && !session.process.isBusy) {
        if (now - session.process.lastActiveAt > idleTimeout) {
          if (this.config.debug) {
            console.debug(`[AntigravitySessionManager] Reaping idle process for ${session.sessionKey}`);
          }
          void session.process.terminate();
          session.process = null;
        }
      }
    }
  }

  public async disposeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    const promises: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      while (session.queue.length > 0) {
        const item = session.queue.shift();
        item?.reject(new Error('Session manager disposed'));
      }
      session.busy = false;
      if (session.process) {
        promises.push(session.process.terminate());
        session.process = null;
      }
    }
    await Promise.all(promises);
    this.sessions.clear();
  }
}
