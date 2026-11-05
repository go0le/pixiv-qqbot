/**
 * 戳一戳（OneBot `notice` / `sub_type=poke`）的互动反馈。
 *
 * 设计取舍：
 * - 纯本地文案 + 表情贴图，不调模型、不分档、不进记忆——戳一戳可能被连点，走模型既慢又费、还可能被滥用；
 * - 会话级冷却（同一个群 / 同一个私聊，cooldownSeconds 内只回一次），别人连戳也不会刷屏；
 * - 只回应「戳我」（target=自己）；我们只回文字、从不回戳，所以不会和别的机器人戳成死循环。
 * 想要更拟人、结合上下文的反馈可以后续改成走一次 guest 回合，但默认保持便宜可靠。
 */
import { envNumber } from './group-chime.ts';

/** 被戳时的反馈池。开头的 `[表情:名]` 会被 deliverAgentResponse 取出换成贴图（白名单内）。 */
export const POKE_REPLIES: string[] = [
  '[表情:害羞] 呀…别戳啦，怪痒的~',
  '[表情:鼓腮] 喂，戳够了没呀，再戳我可要生气了哦！',
  '[表情:闭眼轻笑] 嘿嘿，在呢在呢，戳我干嘛呀~',
  '[表情:惊讶] 唔？！谁在戳我——',
  '[表情:自然微笑] 乖啦别闹，想我陪你聊天还是找图呀？',
  '（猫耳抖了抖）戳一下少一块肉的啦…说吧，找我什么事喵？',
  '[表情:鼓腮] 再戳尾巴就甩你脸上咯！',
  '[表情:害羞] 诶嘿…被你戳得心痒痒的，有话直接说嘛~',
  '（尾巴一甩）别戳啦别戳啦，我又不是按钮喵～',
];

export class PokeReactor {
  private readonly cooldownMs: number;
  private readonly lastAt = new Map<string, number>();
  private lastIdx = -1;

  public constructor(cooldownSec = envNumber('NAPCAT_POKE_COOLDOWN_SEC', 12, 0, 3600)) {
    this.cooldownMs = Math.max(0, cooldownSec) * 1000;
  }

  /** 该会话现在能不能回应戳一戳（带冷却，返回 true 时即记一次时间） */
  public shouldReact(key: string, now = Date.now()): boolean {
    const last = this.lastAt.get(key) ?? 0;
    if (now - last < this.cooldownMs) return false;
    this.lastAt.set(key, now);
    if (this.lastAt.size > 5000) this.lastAt.clear();
    return true;
  }

  /** 取一条反馈文案，尽量不和上一条重复 */
  public pick(): string {
    if (POKE_REPLIES.length === 0) return '';
    let i = Math.floor(Math.random() * POKE_REPLIES.length);
    if (POKE_REPLIES.length > 1 && i === this.lastIdx) i = (i + 1) % POKE_REPLIES.length;
    this.lastIdx = i;
    return POKE_REPLIES[i]!;
  }
}
