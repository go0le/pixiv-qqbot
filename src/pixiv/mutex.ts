/**
 * 异步互斥锁 (Async Mutex) 与键值并发锁 (Keyed Mutex)
 *
 * 用于防止同一聊天会话 (chatKey) 或关键资源发生并发写入竞态。
 * 具备自动垃圾回收特性，防止 KeyedMutex 内存持续泄漏 (P1-01)。
 */

export class AsyncMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  /**
   * 获取锁。返回一个释放锁的函数。
   */
  public acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      let released = false;
      return Promise.resolve(() => {
        if (!released) {
          released = true;
          this.release();
        }
      });
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.locked = true;
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      });
    });
  }

  /**
   * 在锁保护下执行异步操作
   */
  public async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 是否当前被锁定
   */
  public isLocked(): boolean {
    return this.locked;
  }

  /**
   * 是否完全空闲（未锁定且等待队列为空）
   */
  public isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * 按键隔离的互斥锁管理器（如按 chatKey 隔离）
 * 支持空闲自动清理，保证长期运行不泄漏内存
 */
export class KeyedMutex {
  private locks = new Map<string, AsyncMutex>();

  public get(key: string): AsyncMutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new AsyncMutex();
      this.locks.set(key, lock);
    }
    return lock;
  }

  public async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const lock = this.get(key);
    const release = await lock.acquire();
    try {
      return await fn();
    } finally {
      release();
      // 释放后若完全空闲无等待者，自动从 Map 剔除，根治内存泄漏 (P1-01)
      if (lock.isIdle()) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * 当前活跃锁数量（用于可观测性与测试）
   */
  public size(): number {
    return this.locks.size;
  }
}
