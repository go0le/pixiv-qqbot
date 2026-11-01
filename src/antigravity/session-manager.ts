/**
 * Antigravity Session Manager
 *
 * Manages conversation instances across QQ peer targets (C2C users, group chats).
 * Features:
 * - Lazy process instantiation
 * - Deterministic UUID conversation mapping
 * - Reset support (/clear, /reset) with epoch bumps
 * - Automatic idle process reaping to preserve memory
 * - Turn queueing to prevent interleaved prompts
 */
import type { AntigravityConfig } from './types.ts';
import { deriveConversationId, buildSessionKey } from './session-id.ts';
import { AntigravityProcess, type ProcessTurnCallbacks } from './process.ts';

export interface AntigravitySession {
  readonly sessionKey: string;
  readonly scope: 'c2c' | 'group';
  readonly targetId: string;
  readonly userId?: string;
  epoch: number;
  conversationId: string;
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

export class AntigravitySessionManager {
  private readonly sessions = new Map<string, AntigravitySession>();
  private readonly config: AntigravityConfig;
  private readonly groupScope: 'user' | 'group';
  private sweepTimer: NodeJS.Timeout | null = null;

  public constructor(
    config: AntigravityConfig = {},
    groupScope: 'user' | 'group' = 'user',
  ) {
    this.config = config;
    this.groupScope = groupScope;
    this.startIdleSweep();
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
      const epoch = 0;
      const conversationId = deriveConversationId(key, epoch);
      session = {
        sessionKey: key,
        scope,
        targetId,
        userId,
        epoch,
        conversationId,
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
      session.process = new AntigravityProcess(session.conversationId, this.config);
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
    session.lastActiveAt = Date.now();

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
      const result = await proc.sendUserMessage(prompt, callbacks);
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
