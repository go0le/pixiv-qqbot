import { isStaticKnownToken, peelKnownCompound } from '../pixiv/compound.ts';

/**
 * 判断一条 @ 消息是不是「明确要图」：是则软路由到 /pixiv，否则交给哈gemi 正常聊天。
 * 原则：宁可漏路由（让 Gemini 回答），也不要把提问/闲聊误当成搜图。
 */
const QUESTION_RE = /[?？]|吗|呢|么$|什么|是什么|怎么|为什么|为啥|咋|哪个|哪些|多少|几个|是不是|有没有.*(区别|意思)|问的是|我问|请问|解释|介绍|tag是|标签是|tag有|标签有|啥tag|啥标签|指令|命令|帮助|教程/i;
const META_RE = /(这张|那张|刚刚|刚才|上面|上一张|该图|这图|那图).{0,8}(tag|标签|画师|出处|作者)|(tag|标签).{0,6}(对不对|对应|不对|有误)/i;
const COUNT_ASK_RE = /(来|发|整|要|爬|搜|找|给我来|帮我找)\s*(\d{1,3}|[一二两俩三四五六七八九十]+)\s*(张|幅|份|[pP](?![A-Za-z]))/;
const VERB_ASK_RE = /^(来点|来张|来个|来份|来一张|来几张|发张|发点|发一张|整点|整张|给我来|帮我找|帮我搜|找点|搜图|要图|求图)/;
const NOUN_ASK_RE = /(壁纸|插画|涩图|色图|美图|同人图|立绘)$/;
const PIXIV_CMD_RE = /^(pixiv|p站)\s+\S+/i;
/** 明确指向图片的开头：来张 / 发张 / 整张 / 求图 / 要图 / 搜图 */
const SPECIFIC_ASK_RE = /^(来张|来一张|发张|发一张|整张|来几张|求图|要图|搜图)/;
/** 带「张/幅/p」的数量要图（来3张、要五幅）；「份」太泛，不算 */
const IMAGE_COUNT_RE = /(来|发|整|要|爬|搜|找|给我来|帮我找)\s*(\d{1,3}|[一二两俩三四五六七八九十]+)\s*(张|幅|[pP](?![A-Za-z]))/;

export function looksLikePixivImageAsk(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith('/')) return false;
  if (QUESTION_RE.test(t) || META_RE.test(t)) return false;
  if (PIXIV_CMD_RE.test(t)) return true;
  if (COUNT_ASK_RE.test(t)) return true;
  if (VERB_ASK_RE.test(t)) return true;
  if (/^(搜|找|爬)/.test(t) && NOUN_ASK_RE.test(t)) return true;
  if (NOUN_ASK_RE.test(t) && t.length <= 20 && !/[，,。]/.test(t)) return true;
  return false;
}

// ───────────────────────── 搜图槽位：承接 / 重述 / 新请求 ─────────────────────────

const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200d]+/gu;
const NUM = '(?:\\d{1,2}|[一二两俩三四五六七八九十])';
/**
 * 纯指代：再来一张 / 换一张 / 下一张 / 再来三张 / 继续发图。必须带量词（张/幅/份）或「图」字，
 * 单独的「继续」「然后」「换个」「下一个」是日常对话，不算要图。
 */
const ANAPHOR_RE = new RegExp(
  `^(?:再|继续|接着|然后|换|下)(?:来|发|整|给我?|搞|换)?(?:${NUM})?(?:张|幅|份)(?:图片|图)?(?:吧|啊|呀|嘛|呗|哦|哈)?$`
  + `|^(?:再|换)(?:来|发|整|给我?|搞)?(?:${NUM})?(?:张|幅|份)?图(?:片)?(?:吧|啊|呀|嘛|呗|哦|哈)?$`,
);
/** 否定/删除语气：「不要r18标签」「去掉巨乳标签」不是在要这些标签，交给 Agent 处理，绝不能当成搜图词 */
const NEGATION_RE = /不要|别要|别带|别加|别给|不想要|不想看|不看|不带|不含|不加|去掉|去除|删掉|删除|排除|除了|除开|没有|不是/;
/** 开头的承接词：这些不改变「是不是要图」，剥掉后再判断 */
const CONTINUE_PREFIX_RE = /^(?:(?:那就|那再|那|然后|好的?|嗯+|哦+|行|ok)[，,\s]*)+/i;
const RESTATE_LEAD_RE = /^(?:就是|就|是|我要|我想要|想要|只要|只想要|要|有|带|得有|必须有|需要|还要|再加|加上|加|给我)+/;
const RESTATE_TAIL_RE = /^[和与跟及、,，\s+＋啦吧啊呀哦嘛哈的就是有]*$/;
const TAG_SEGMENT_RE = /([^\s,，、。和与跟及+＋]{1,16}?)\s*(?:tags?|标签)/gi;

export type ImageAsk =
  /** 纯指代（再来一张）：只能继承上一轮的主角色，其余槽位清空 */
  | { kind: 'anaphor'; count?: number }
  /** 用户重述标签（「就是有A和B啦」）：以本条消息的标签全量覆盖 */
  | { kind: 'restate'; keyword: string }
  /** 带新内容的要图：以本条消息全量重写，不继承任何旧槽位 */
  | { kind: 'fresh'; keyword: string; count?: number };

function normalizeAsk(text: string): string {
  return text.replace(EMOJI_RE, '').replace(/[~～!！。.…]+$/g, '').trim();
}

/** 「就是有巨乳tag和龙华妃咲tag啦」→ ['巨乳','龙华妃咲']；不是纯重述句式返回 null。 */
export function parseTagRestate(
  text: string,
  isKnown: (t: string) => boolean = isStaticKnownToken,
): string[] | null {
  const t = normalizeAsk(text);
  if (!t || !/(?:tags?|标签)/i.test(t)) return null;
  if (QUESTION_RE.test(t) || META_RE.test(t) || NEGATION_RE.test(t)) return null;
  const names: string[] = [];
  const rest = t.replace(TAG_SEGMENT_RE, (_m, name: string) => {
    const n = name.replace(RESTATE_LEAD_RE, '').replace(/的$/, '').trim();
    if (n) names.push(n);
    return ' ';
  });
  if (names.length === 0 || !RESTATE_TAIL_RE.test(rest)) return null;
  // 至少一个标签名是已收录词，才认为这真的是在重述搜图条件；全是陌生词多半是在聊别的
  const knownName = (n: string): boolean => isKnown(n) || peelKnownCompound(n, isKnown) !== null;
  if (!names.some(knownName)) return null;
  return Array.from(new Set(names));
}

/**
 * 判断一条消息属于哪种要图意图。返回 null 表示不是要图（交给 Agent 正常聊天）。
 * @param parse 自然语言 → 关键词/数量的解析器（避免本文件依赖 pixiv 服务）
 */
export function classifyImageAsk(
  text: string,
  parse: (s: string) => { keyword: string; count?: number },
  isKnown: (t: string) => boolean = isStaticKnownToken,
): ImageAsk | null {
  const t = normalizeAsk(text);
  if (!t || t.startsWith('/')) return null;

  const restate = parseTagRestate(t, isKnown);
  if (restate) return { kind: 'restate', keyword: restate.join(' ') };

  if (t.length >= 2 && !QUESTION_RE.test(t) && ANAPHOR_RE.test(t.replace(/\s+/g, ''))) {
    return { kind: 'anaphor', count: parse(t).count };
  }

  // 带否定/删除语气的话（不要r18、去掉巨乳…）不当搜图词，交给 Agent
  if (NEGATION_RE.test(t)) return null;

  // 「再来张巨乳」「那来张女仆」：剥掉承接词后按普通要图判断；
  // 有新内容就是全量重写，不继承前文任何标签
  const core = t.replace(/^再(?=来|发|整|给|搞)/, '').replace(CONTINUE_PREFIX_RE, '').trim();
  if (!looksLikePixivImageAsk(core)) return null;
  const nq = parse(core);
  if (!nq.keyword) return null;

  // 「来张/求图/N张」本身就指向图片；「来点/来个/整点/帮我找」是通用动词（来个总结、整点活），
  // 必须再有图片名词结尾，或者关键词里有已收录的角色/属性词，才认为是要图
  const imageSpecific = SPECIFIC_ASK_RE.test(core) || PIXIV_CMD_RE.test(core) || IMAGE_COUNT_RE.test(core);
  if (!imageSpecific) {
    const tokens = nq.keyword.split(/\s+/).filter(Boolean);
    const hasKnown = tokens.some(tok => isKnown(tok) || peelKnownCompound(tok, isKnown) !== null);
    if (!NOUN_ASK_RE.test(core) && !hasKnown) return null;
  }
  return { kind: 'fresh', keyword: nq.keyword, count: nq.count };
}
