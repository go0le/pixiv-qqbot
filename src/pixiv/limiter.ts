/**
 * Pixiv 检索频率控制器 (Rate Limiter & Cooldown)
 *
 * 每个 QQ 会话 (${scope}:${targetId}) 实施 15 秒 CD 冷却，
 * 防止无意义的高频并发请求挤占带宽与刷屏。
 */

/** 默认冷却时长 (毫秒)：15 秒 */
export const DEFAULT_PIXIV_COOLDOWN_MS = 15_000;

export interface LimiterCheckResult {
  allowed: boolean;
  remainingSec: number;
}

export class PixivRateLimiter {
  private readonly cooldownMs: number;
  private readonly lastAccessMap: Map<string, number> = new Map();

  public constructor(cooldownMs = DEFAULT_PIXIV_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs;
  }

  /**
   * 检查是否允许触发 (仅检查，不记录本次触发时间)
   */
  public check(chatKey: string, now = Date.now()): LimiterCheckResult {
    const last = this.lastAccessMap.get(chatKey);
    if (!last) {
      return { allowed: true, remainingSec: 0 };
    }

    const elapsed = now - last;
    if (elapsed >= this.cooldownMs) {
      return { allowed: true, remainingSec: 0 };
    }

    const remainingSec = Math.max(1, Math.ceil((this.cooldownMs - elapsed) / 1000));
    return { allowed: false, remainingSec };
  }

  /**
   * 记录触发时间戳
   */
  public record(chatKey: string, now = Date.now()): void {
    this.lastAccessMap.set(chatKey, now);
  }

  /**
   * 消费一次冷却：检查并在允许时立即记录
   */
  public consume(chatKey: string, now = Date.now()): LimiterCheckResult {
    const result = this.check(chatKey, now);
    if (result.allowed) {
      this.record(chatKey, now);
    }
    return result;
  }

  /**
   * 重置冷却时间 (用于单元测试或管理员重置)
   */
  public reset(chatKey?: string): void {
    if (chatKey !== undefined) {
      this.lastAccessMap.delete(chatKey);
    } else {
      this.lastAccessMap.clear();
    }
  }
}

/** 全局单例 */
export const defaultPixivLimiter = new PixivRateLimiter();
