/**
 * 搜图槽位：每个「会话 + 用户」只记住上一次搜图的主角色，用来回答「再来一张」这类纯指代。
 *
 * 规则（对应 2026.11.3.md 的 Tag 滞留 / R-18 跨轮继承问题）：
 * - 有主角色时只继承主角色；体型/服装等属性词、数量、R-18 与其它灰名单授权一律不继承；
 * - 上一次本来就没有主角色（如「来张巨乳」）时，只带回它的非灰名单属性词，灰名单仍然剔除；
 * - 任何带新内容的要图都是全量重写，旧槽位被整体替换；
 * - 槽位有 TTL，超时作废；/clear 同步清空。
 */
import { isControlOrGreylistToken, pickSubjectToken, stripGreylistWords } from '../pixiv/compound.ts';

export interface SearchSlot {
  /** 「再来一张」时带回的搜索词：主角色；没有主角色时是去掉灰名单/控制词后的属性词；都没有则为 undefined */
  carry?: string;
  /** 记录槽位时的完整关键词，仅用于日志 */
  lastKeyword: string;
  updatedAt: number;
}

export class SearchSlotTracker {
  private readonly slots = new Map<string, SearchSlot>();

  /**
   * @param isKnown 判断「剩余部分」是否是已收录词（可接动态映射表），默认只看静态词表
   */
  public constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly isKnown?: (t: string) => boolean,
  ) {}

  public static keyFor(scope: string, targetId: string, userId: string): string {
    return `${scope}:${targetId}:${userId}`;
  }

  /** 以本次搜图的关键词整体覆盖槽位 */
  public record(key: string, keyword: string): SearchSlot {
    // 先剥掉灰名单词（含粘在角色名上的 r18龙华妃咲），再决定要带回什么
    const tokens = keyword
      .split(/\s+/)
      .map(stripGreylistWords)
      .flatMap(t => t.split(/\s+/))
      .filter(Boolean);
    const subject = pickSubjectToken(tokens, this.isKnown);
    const slot: SearchSlot = {
      carry: subject ?? (tokens.filter(t => !isControlOrGreylistToken(t)).join(' ') || undefined),
      lastKeyword: keyword,
      updatedAt: Date.now(),
    };
    this.slots.set(key, slot);
    return slot;
  }

  /** 取未过期的槽位 */
  public get(key: string): SearchSlot | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    if (Date.now() - slot.updatedAt > this.ttlMs) {
      this.slots.delete(key);
      return undefined;
    }
    return slot;
  }

  public reset(key: string): void {
    this.slots.delete(key);
  }
}
