/**
 * Antigravity CLI Process Wrapper
 *
 * Spawns and manages an agy CLI process in stream-json mode:
 * agy --conversation <id> --input-format stream-json --output-format stream-json --dangerously-skip-permissions
 *
 * Parses incoming NDJSON line by line, emits typed events, handles timeouts,
 * captures text deltas, and resolves turn results.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  AgyErrorEvent,
  AgyInitData,
  AgyOutputEvent,
  AgyResultData,
  AgyStepUpdateData,
  AntigravityConfig,
} from './types.ts';

export function resolveAgyPath(customPath?: string): string {
  if (customPath) return customPath;
  if (process.env.AGY_PATH) return process.env.AGY_PATH;
  const homeAgy = path.join(os.homedir(), '.local/bin/agy');
  if (existsSync(homeAgy)) return homeAgy;
  return 'agy';
}

export interface ProcessTurnCallbacks {
  onDelta?: (delta: string) => void;
  onStepUpdate?: (step: AgyStepUpdateData) => void;
}

/**
 * 会一直占着这一轮不结束的工具。schedule 是「定时唤醒」：agy 会把这一轮挂起到定时器到点（实测 21 分钟），
 * 期间同一会话的新消息全部排队，机器人只能等到超时。机器人场景里遇到就立刻打断，让模型改用系统定时任务。
 * AGY_BLOCKING_TOOLS 可改（逗号分隔，空字符串表示不拦）。
 */
const BLOCKING_TOOLS = new Set(
  (process.env.AGY_BLOCKING_TOOLS ?? 'schedule').split(',').map(s => s.trim()).filter(Boolean),
);
/** 模型已经写完回复、但 agy 迟迟不结束这一轮（在等后台任务）时，最多再等多久就把已写好的回复交出去 */
const IDLE_AFTER_REPLY_MS = Math.max(1000, Number(process.env.AGY_IDLE_AFTER_REPLY_MS) || 30_000);

/** 这一轮调用了会挂起整轮的工具（见 BLOCKING_TOOLS），已被打断 */
export class AgyBlockedToolError extends Error {
  public constructor(public readonly tool: string, public readonly partialText: string) {
    super(`agy 调用了会挂起本轮的工具 ${tool}，已打断`);
    this.name = 'AgyBlockedToolError';
  }
}

/** 这一轮长时间没有任何输出，已超时打断；partialText 是超时前模型已经写出来的内容 */
export class AgyTurnTimeoutError extends Error {
  public constructor(timeoutMs: number, public readonly partialText: string) {
    super(`Turn timed out after ${timeoutMs}ms of inactivity`);
    this.name = 'AgyTurnTimeoutError';
  }
}

export class AntigravityProcess extends EventEmitter {
  public readonly conversationId: string;
  private readonly config: AntigravityConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private _lastActiveAt: number = Date.now();
  private isTerminating = false;
  private currentTurnReject: ((err: Error) => void) | null = null;
  private currentTurnResolve: ((result: AgyResultData) => void) | null = null;
  private currentTurnCallbacks: ProcessTurnCallbacks | null = null;
  private turnTimeoutTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private initPromise: Promise<AgyInitData> | null = null;
  private initResolve: ((data: AgyInitData) => void) | null = null;
  private turnAccumulatedText = '';
  /** agy 实际使用的会话 ID（来自 init/result 事件）；可能和传入的 conversationId 不同 */
  private _agyConversationId: string | null = null;
  /** 正在进行的结束流程；新的一轮必须等它结束、换一个新进程，不能写进正在退出的进程（2026-11-05 漏接消息） */
  private terminating: Promise<void> | null = null;
  /** 「回复已写完但这一轮不结束」的计时器 */
  private idleAfterReplyTimer: NodeJS.Timeout | null = null;

  public get agyConversationId(): string | null {
    return this._agyConversationId;
  }
  public constructor(conversationId: string, config: AntigravityConfig = {}) {
    super();
    this.conversationId = conversationId;
    this.config = {
      agyPath: resolveAgyPath(config.agyPath),
      cwd: config.cwd || process.cwd(),
      dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
      idleTimeoutMs: config.idleTimeoutMs ?? 15 * 60 * 1000,
      turnTimeoutMs: config.turnTimeoutMs ?? 10 * 60 * 1000,
      extraArgs: config.extraArgs || (process.env.AGY_EXTRA_ARGS ? process.env.AGY_EXTRA_ARGS.split(" ").filter(Boolean) : []),
      env: config.env,
      // 访客档用它整份替换子进程环境、剔除 QQ 机器人凭据（第二轮 S1）。之前这里漏拷了这一项，替换从未生效
      replaceEnv: config.replaceEnv,
      debug: config.debug ?? false,
    };
  }

  public get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  public get isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null && !this.isTerminating;
  }

  public get isBusy(): boolean {
    return this.currentTurnResolve !== null;
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /**
   * Spawns the agy child process if not already running.
   */
  public start(): Promise<AgyInitData> {
    if (this.isRunning && this.initPromise) {
      return this.initPromise;
    }

    this._lastActiveAt = Date.now();
    this.isTerminating = false;

    this.initPromise = new Promise<AgyInitData>((resolve, reject) => {
      this.initResolve = resolve;

      // 10s fallback timer: if agy does not emit an explicit init event but process is running,
      // resolve readiness so the queue is not indefinitely blocked.
      this.startupTimer = setTimeout(() => {
        if (this.initResolve) {
          if (this.config.debug) {
            console.debug(`[AntigravityProcess] 10s startup timer elapsed; resolving init readiness for ${this.conversationId}`);
          }
          const fn = this.initResolve;
          this.initResolve = null;
          fn({});
        }
      }, 10000);
      this.startupTimer.unref?.();

      const args = [
        '--conversation',
        this._agyConversationId ?? this.conversationId,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ];

      if (this.config.dangerouslySkipPermissions) {
        args.push('--dangerously-skip-permissions');
      }

      if (this.config.extraArgs && this.config.extraArgs.length > 0) {
        args.push(...this.config.extraArgs);
      }

      const agyBin = this.config.agyPath!;
      if (this.config.debug) {
        console.debug(`[AntigravityProcess] Spawning: ${agyBin} ${args.join(' ')}`);
      }

      try {
        this.child = spawn(agyBin, args, {
          cwd: this.config.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // 让 agy 自成一个进程组。agy 会再拉起 MCP 子进程（pixiv、memoryos；memoryos 常驻约 3.5GB），
          // 结束 agy 时按进程组一起结束，否则这些子进程会变成孤儿继续占内存（2026-11-05 两次 OOM）。
          detached: true,
          env: this.config.replaceEnv
            ? { ...this.config.replaceEnv, FORCE_COLOR: '0' }
            : {
                ...process.env,
                ...(this.config.env ?? {}),
                FORCE_COLOR: '0',
              },
        });
      } catch (err) {
        this.clearStartupTimer();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const child = this.child;
      this.child.on('error', (err) => {
        if (this.child !== child) return; // 已经换了新进程，旧进程的事件不再影响当前状态
        this.clearStartupTimer();
        if (this.config.debug) {
          console.error(`[AntigravityProcess] Process error (${this.conversationId}):`, err);
        }
        this.emit('error', err);
        if (this.initResolve) {
          this.initResolve = null;
          reject(err);
        }
        if (this.currentTurnReject) {
          this.currentTurnReject(err);
          this.cleanupTurn();
        }
      });

      const groupId = this.child.pid;
      this.child.on('exit', (code, signal) => {
        // agy 不管因为什么退出（被回收、超时、崩溃），它拉起的 MCP 子进程都没用了：整组清掉
        AntigravityProcess.reapGroup(groupId);
        if (this.child !== child) return; // 已经换了新进程
        this.clearStartupTimer();
        if (this.config.debug) {
          console.debug(`[AntigravityProcess] Process exit (${this.conversationId}): code=${code}, signal=${signal}`);
        }
        this.emit('exit', code, signal);
        if (this.initResolve) {
          this.initResolve = null;
          reject(new Error(`agy process exited prematurely with code ${code}`));
        }
        if (this.currentTurnReject) {
          const err = new Error(
            this.isTerminating
              ? 'Turn aborted because process was terminated'
              : `agy process exited unexpectedly with code ${code}`
          );
          this.currentTurnReject(err);
          this.cleanupTurn();
        }
        this.cleanupChild();
      });

      this.child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (this.config.debug) {
          console.error(`[AntigravityProcess:stderr] ${text}`);
        }
      });

      this.rl = createInterface({
        input: this.child.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this.handleLine(trimmed);
      });
    });

    return this.initPromise;
  }

  private handleLine(line: string): void {
    let parsed: AgyOutputEvent;
    try {
      parsed = JSON.parse(line) as AgyOutputEvent;
    } catch {
      if (this.config.debug) {
        console.warn(`[AntigravityProcess] Non-JSON stdout line: ${line}`);
      }
      return;
    }

    this._lastActiveAt = Date.now();
    this.resetTurnTimeout();
    this.clearIdleAfterReply();

    // If an init promise is pending and any valid NDJSON arrives, resolve it
    if (this.initResolve) {
      this.clearStartupTimer();
      const fn = this.initResolve;
      this.initResolve = null;
      fn(parsed.event === 'init' ? (parsed.init ?? {}) : {});
    }

    // agy 会自己分配会话 ID（它忽略本地不存在的 --conversation），在 init/result 事件里告诉我们真实 ID。
    // 记下来交给会话管理器持久化，下次启动用它续接上下文。
    const reportedId = (parsed as { conversation_id?: unknown }).conversation_id
      ?? (parsed as { result?: { conversation_id?: unknown } }).result?.conversation_id;
    if (typeof reportedId === 'string' && reportedId && reportedId !== this._agyConversationId) {
      this._agyConversationId = reportedId;
      this.emit('conversation', reportedId);
    }

    switch (parsed.event) {
      case 'init': {
        this.emit('init', parsed.init ?? {});
        break;
      }

      case 'step_update': {
        const step = parsed.step_update;
        this.emit('step_update', step);

        if (this.currentTurnCallbacks?.onStepUpdate) {
          this.currentTurnCallbacks.onStepUpdate(step);
        }

        const delta = typeof step.text_delta === 'string' && step.text_delta
          ? step.text_delta
          : typeof step.delta === 'string' && step.delta
            ? step.delta
            : '';

        if (delta) {
          this.turnAccumulatedText += delta;
          this.emit('text_delta', delta);
          if (this.currentTurnCallbacks?.onDelta) {
            this.currentTurnCallbacks.onDelta(delta);
          }
        }

        const stepType = (step as { step_type?: unknown }).step_type;
        const state = (step as { state?: unknown }).state;
        const toolName = (step as { tool_name?: unknown }).tool_name;
        if (this.currentTurnReject && stepType === 'tool' && state === 'ACTIVE'
          && typeof toolName === 'string' && BLOCKING_TOOLS.has(toolName)) {
          console.warn(`[AntigravityProcess] ${this.conversationId}: blocking tool "${toolName}" called, interrupting the turn`);
          const reject = this.currentTurnReject;
          const partial = this.turnAccumulatedText;
          this.cleanupTurn();
          reject(new AgyBlockedToolError(toolName, partial));
          void this.terminate();
          break;
        }
        // 模型说完一段话（agent_response DONE）之后正常会立刻有下一步或 result；
        // 一直没有，就是 agy 在等后台任务（实测：schedule 转入后台后，本轮挂到定时器到点才结束）
        if (this.currentTurnResolve && stepType === 'agent_response' && state === 'DONE' && this.turnAccumulatedText.trim()) {
          this.armIdleAfterReply();
        }
        break;
      }

      case 'error': {
        const errObj = (parsed as AgyErrorEvent).error;
        const errMsg = typeof errObj === 'string'
          ? errObj
          : typeof errObj?.message === 'string'
            ? errObj.message
            : typeof (parsed as AgyErrorEvent).message === 'string'
              ? (parsed as AgyErrorEvent).message
              : 'Antigravity CLI error event';
        const error = new Error(errMsg);
        if (this.listenerCount('error') > 0) {
          this.emit('error', error);
        }
        if (this.currentTurnReject) {
          this.currentTurnReject(error);
        }
        this.cleanupTurn();
        break;
      }

      case 'result': {
        const result = parsed.result;
        const failed = typeof result.status === 'string' && result.status !== 'SUCCESS';
        if (failed) {
          // 被打断/出错时 agy 给的 response 可能是空的，也可能是上一轮的旧内容；只认这一轮实际收到的文字
          result.response = this.turnAccumulatedText;
        } else if (!result.response && this.turnAccumulatedText) {
          result.response = this.turnAccumulatedText;
        }
        this.emit('result', result);

        // 被打断（收到 SIGTERM 等）的 agy 输出这条 result 后马上会退出：先把它标成「正在结束」，
        // 下一条消息就会等它退干净再起新进程，而不是写进一个快要退出的进程
        const reasonText = String((result as { error?: unknown }).error ?? (result as { finished_reason?: unknown }).finished_reason ?? '');
        if (failed && /interrupt|cancel/i.test(reasonText)) {
          void this.terminate();
        }

        if (failed && !result.response.trim()) {
          if (this.currentTurnReject) {
            const reason = (result as { error?: unknown }).error;
            this.currentTurnReject(new Error(`agy 本轮异常结束：${typeof reason === 'string' && reason ? reason : result.status}`));
          }
        } else if (this.currentTurnResolve) {
          this.currentTurnResolve(result);
        }
        this.cleanupTurn();
        break;
      }

      default:
        break;
    }
  }

  /**
   * Sends a user prompt to the agy process and waits for the turn result.
   */
  public async sendUserMessage(
    prompt: string,
    callbacks?: ProcessTurnCallbacks,
  ): Promise<AgyResultData> {
    if (this.isBusy) {
      throw new Error('A turn is already in progress for this conversation.');
    }

    // 上一轮超时/被打断时进程正在退出：等它退干净，再用同一个 agy 会话 ID 起新进程续接上下文
    if (this.terminating) {
      await this.terminating;
    }
    if (!this.isRunning) {
      await this.start();
    }

    this._lastActiveAt = Date.now();
    this.turnAccumulatedText = '';
    this.currentTurnCallbacks = callbacks || null;

    return new Promise<AgyResultData>((resolve, reject) => {
      this.currentTurnResolve = resolve;
      this.currentTurnReject = reject;

      this.resetTurnTimeout();

      // Write NDJSON line to stdin
      const inputLine = JSON.stringify({
        event: 'user',
        message: { content: prompt },
      }) + '\n';

      try {
        this.child!.stdin.write(inputLine, (err) => {
          if (err) {
            reject(err);
            this.cleanupTurn();
          }
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        this.cleanupTurn();
      }
    });
  }

  private resetTurnTimeout(): void {
    if (this.currentTurnReject) {
      if (this.turnTimeoutTimer) {
        clearTimeout(this.turnTimeoutTimer);
      }
      const timeoutMs = this.config.turnTimeoutMs ?? 600000;
      this.turnTimeoutTimer = setTimeout(() => {
        if (this.currentTurnReject) {
          const reject = this.currentTurnReject;
          const partial = this.turnAccumulatedText;
          this.cleanupTurn();
          reject(new AgyTurnTimeoutError(timeoutMs, partial));
          void this.terminate();
        }
      }, timeoutMs);
    }
  }

  private clearIdleAfterReply(): void {
    if (this.idleAfterReplyTimer) {
      clearTimeout(this.idleAfterReplyTimer);
      this.idleAfterReplyTimer = null;
    }
  }

  /** 回复写完后 IDLE_AFTER_REPLY_MS 内没有任何新事件：把已写好的回复交出去，并结束这个 agy（后台任务在机器人里交付不了） */
  private armIdleAfterReply(): void {
    this.clearIdleAfterReply();
    this.idleAfterReplyTimer = setTimeout(() => {
      this.idleAfterReplyTimer = null;
      const resolve = this.currentTurnResolve;
      if (!resolve) return;
      const text = this.turnAccumulatedText;
      console.warn(`[AntigravityProcess] ${this.conversationId}: reply finished but turn still open after ${IDLE_AFTER_REPLY_MS}ms (background task?), delivering reply and recycling the process`);
      this.cleanupTurn();
      resolve({ conversation_id: this._agyConversationId ?? this.conversationId, status: 'SUCCESS', response: text, finished_reason: 'idle_after_reply' });
      void this.terminate();
    }, IDLE_AFTER_REPLY_MS);
    this.idleAfterReplyTimer.unref?.();
  }

  private cleanupTurn(): void {
    this.clearIdleAfterReply();
    if (this.turnTimeoutTimer) {
      clearTimeout(this.turnTimeoutTimer);
      this.turnTimeoutTimer = null;
    }
    this.currentTurnResolve = null;
    this.currentTurnReject = null;
    this.currentTurnCallbacks = null;
    this.turnAccumulatedText = '';
    this._lastActiveAt = Date.now();
  }

  private cleanupChild(): void {
    this.clearStartupTimer();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.child = null;
    this.initPromise = null;
    this.initResolve = null;
  }

  /**
   * 给 agy 的整个进程组（agy + 它拉起的 MCP 子进程）发信号。进程组已经空了（ESRCH）就忽略。
   * 返回 false 表示没有这个进程组。
   */
  private static signalGroup(groupId: number | undefined, sig: NodeJS.Signals): boolean {
    if (!groupId) return false;
    try {
      process.kill(-groupId, sig);
      return true;
    } catch {
      return false;
    }
  }

  /** agy 退出后清掉组里剩下的进程：先 SIGTERM，3 秒后还在的 SIGKILL */
  private static reapGroup(groupId: number | undefined): void {
    if (!AntigravityProcess.signalGroup(groupId, 'SIGTERM')) return;
    const t = setTimeout(() => AntigravityProcess.signalGroup(groupId, 'SIGKILL'), 3000);
    t.unref?.();
  }

  /**
   * 结束 agy 及其 MCP 子进程：整组 SIGTERM，3 秒内没退出就整组 SIGKILL。
   * agy 退出后 exit 回调里还会再清一次组里剩下的进程。
   */
  public async terminate(): Promise<void> {
    if (this.terminating) return this.terminating;
    if (!this.isRunning) {
      this.cleanupChild();
      return;
    }

    this.isTerminating = true;
    this.clearIdleAfterReply();

    this.terminating = new Promise<void>((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }
      const groupId = child.pid;

      let killTimer: NodeJS.Timeout | null = setTimeout(() => {
        if (!AntigravityProcess.signalGroup(groupId, 'SIGKILL')) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 3000);

      child.once('exit', () => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        this.cleanupChild();
        resolve();
      });

      if (!AntigravityProcess.signalGroup(groupId, 'SIGTERM')) {
        try {
          child.kill('SIGTERM');
        } catch {
          resolve();
        }
      }
    }).finally(() => {
      this.terminating = null;
    });
    return this.terminating;
  }
}
