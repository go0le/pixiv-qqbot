/**
 * 识别用户对哈Gemi 发的图的反馈：喜欢 / 不喜欢 / 拉黑这个画师。
 *
 * 只认短句：引用她发的图时最多 40 字，没引用时最多 16 字（而且适配器只在刚发过图的会话里才看没引用的反馈）。
 * 长句、问句一律不算，宁可漏记也不要把聊天内容误当成偏好。
 */

export type ImageFeedback = 'like' | 'dislike' | 'block-artist';

const BLOCK_ARTIST_RE = /(拉黑|屏蔽|黑名单|ban掉?)\s*(这个|这位|该|此|他|她)?\s*(画师|作者|太太|画手)|(别|不要|不许|别再|不要再|不想再?看)\s*(再)?\s*(发|推|给我发|看到?)?\s*(这个|这位|他|她|该|此)\s*(画师|作者|太太|画手)/i;
const DISLIKE_RE = /不(太|怎么|是很|够)?(好看|喜欢|可爱|行|对味|戳|咋样|怎么样)|难看|好丑|太丑|丑死|丑哭|^丑|一般般?|下头|无感|没感觉|(别|不要|不想)(再)?(发|看|要)?(这种|这类|这样的)|什么鬼|辣眼睛|差评|这张不行|不太行/;
const LIKE_RE = /好看|好美|好可爱|可爱|好棒|真棒|不错|喜欢|爱了|好图|神图|绝了|好耶|好涩|好色|涩涩|色色|太太牛|画得好|画的好|nice|好评|漂亮|美哭|戳我|对味|xp|❤|♥|😍|🥰|👍/i;
/** 问句（「好看吗」「这是谁画的」）不算反馈 */
const QUESTION_RE = /[?？]|吗|么$|谁|哪|是什么|为什么|怎么(?!样)/;

export function classifyImageFeedback(text: string, opts: { quoted: boolean }): ImageFeedback | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('/')) return null;
  if (t.length > (opts.quoted ? 40 : 16)) return null;
  if (BLOCK_ARTIST_RE.test(t)) return 'block-artist';
  if (QUESTION_RE.test(t) && !/什么鬼/.test(t)) return null;
  if (DISLIKE_RE.test(t)) return 'dislike';
  if (LIKE_RE.test(t)) return 'like';
  return null;
}

/**
 * 反馈后面跟着的「换一张 / 再来一张」：返回那一段，交给要图判断；没有返回 null。
 * 例：「不好看，换一张」→「换一张」。
 */
export function trailingImageAsk(text: string): string | null {
  const parts = text.split(/[，,。.!！~～\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  return /^(再|换|下)(来|发|整|给我?)?(一|1|两|2|三|3)?(张|幅)(图)?(吧|呗|啊|呀)?$/.test(last) ? last : null;
}
