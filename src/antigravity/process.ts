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

  public constructor(conversationId: string, config: AntigravityConfig = {}) {
    super();
    this.conversationId = conversationId;
    this.config = {
      agyPath: resolveAgyPath(config.agyPath),
      cwd: config.cwd || process.cwd(),
      dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
      idleTimeoutMs: config.idleTimeoutMs ?? 15 * 60 * 1000,
      turnTimeoutMs: config.turnTimeoutMs ?? 10 * 60 * 1000,
      extraArgs: config.extraArgs || [],
      debug: config.debug ?? false,
    };
  }

  public get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  public get isRunning(): boolean {
    return this.child !== null && !this.child.killed && this.child.exitCode === null;
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
        this.conversationId,
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
          env: {
            ...process.env,
            FORCE_COLOR: '0',
          },
        });
      } catch (err) {
        this.clearStartupTimer();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.child.on('error', (err) => {
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

      this.child.on('exit', (code, signal) => {
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

    // If an init promise is pending and any valid NDJSON arrives, resolve it
    if (this.initResolve) {
      this.clearStartupTimer();
      const fn = this.initResolve;
      this.initResolve = null;
      fn(parsed.event === 'init' ? (parsed.init ?? {}) : {});
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
        if (!result.response && this.turnAccumulatedText) {
          result.response = this.turnAccumulatedText;
        }
        this.emit('result', result);

        if (this.currentTurnResolve) {
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
          this.currentTurnReject(new Error(`Turn timed out after ${timeoutMs}ms of inactivity`));
          this.cleanupTurn();
          this.terminate();
        }
      }, timeoutMs);
    }
  }

  private cleanupTurn(): void {
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
   * Terminates the agy process gracefully (SIGTERM), and forces (SIGKILL) after 3s.
   */
  public async terminate(): Promise<void> {
    if (!this.isRunning) {
      this.cleanupChild();
      return;
    }

    this.isTerminating = true;

    return new Promise<void>((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }

      let killTimer: NodeJS.Timeout | null = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
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

      try {
        child.kill('SIGTERM');
      } catch {
        resolve();
      }
    });
  }
}
