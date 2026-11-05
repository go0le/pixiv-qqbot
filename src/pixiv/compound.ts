/**
 * 复合词拆解：把「属性词 + 角色名」无空格粘连的输入（如 巨乳妃咲）拆开。
 * 与 service / tag-oracle / 适配器共用，本文件不依赖网络和 LLM。
 */
import { CHARACTER_TAG_MAP, COMMON_ATTR_MAP, GREYLIST_CATEGORIES } from './constants.ts';
import { normalizeForFilter } from './filter.ts';

/** 体型/特征词：本地确定性词典，避免 LLM 把「贫乳」「巨乳」搞反或漏掉 */
export const FEATURE_DICT: Record<string, string> = {
  贫乳: '貧乳', 貧乳: '貧乳', 平胸: '貧乳', 贫胸: '貧乳', 微乳: '貧乳', 小胸: '貧乳', 飞机场: '貧乳',
  巨乳: '巨乳', 爆乳: '爆乳', 大胸: '巨乳', 大奶: '巨乳', 奶子大: '巨乳',
  大姐姐: 'お姉さん', 御姐: 'お姉さん', 姐姐: 'お姉さん',
  白毛: '白髪', 白发: '白髪', 银发: '銀髪', 黑发: '黒髪', 金发: '金髪', 粉发: 'ピンク髪',
  双马尾: 'ツインテール', 单马尾: 'ポニーテール', 马尾: 'ポニーテール',
  猫耳: '猫耳', 兽耳: '獣耳', 狐耳: '狐耳', 兔耳: 'うさ耳',
  眼镜: '眼鏡', 眼镜娘: '眼鏡っ娘', 萌妹: '美少女', 美少女: '美少女',
};

const CJK_RE = /[\u4e00-\u9fff]/;
const CONNECTORS = '的和与跟及、';

/** 可从复合词两端剥离的属性词（仅含汉字的 ≥2 字词条），长词优先 */
const ATTR_KEYS: string[] = Array.from(new Set([
  ...Object.keys(FEATURE_DICT),
  ...Object.keys(COMMON_ATTR_MAP),
])).filter(k => k.length >= 2 && CJK_RE.test(k)).sort((a, b) => b.length - a.length);

export interface PeeledToken {
  /** 被剥离出的属性词（原文，非规范标签） */
  features: string[];
  /** 剩余部分（通常是角色名或未收录词） */
  rest: string;
}

function trimConnectors(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && CONNECTORS.includes(s[a]!)) a++;
  while (b > a && CONNECTORS.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/**
 * 从词首/词尾反复剥离属性词。
 * 只有「至少剥出一个属性词，且剩余部分 ≥2 字」才算拆解成功，否则返回 null
 * （剩余为空说明整词都是属性词，交给词典最长匹配切分处理）。
 */
export function peelFeatureWords(token: string): PeeledToken | null {
  if (!CJK_RE.test(token)) return null;
  let rest = token.trim();
  const features: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    rest = trimConnectors(rest);
    const head = ATTR_KEYS.find(k => rest.length > k.length && rest.startsWith(k));
    if (head) {
      features.push(head);
      rest = rest.slice(head.length);
      progressed = true;
      continue;
    }
    const tail = ATTR_KEYS.find(k => rest.length > k.length && rest.endsWith(k));
    if (tail) {
      features.push(tail);
      rest = rest.slice(0, rest.length - tail.length);
      progressed = true;
    }
  }
  rest = trimConnectors(rest);
  if (features.length === 0 || rest.length < 2) return null;
  return { features, rest };
}

const CONTROL_RE = /^(\d+|r-?18g?|壁纸|壁紙)$/i;

/** 控制类 token：数量、R-18 开关、壁纸，以及任何灰名单类别词（r18 / 口交 / 中出 …）。 */
export function isControlOrGreylistToken(token: string): boolean {
  const t = token.trim();
  if (!t) return true;
  if (CONTROL_RE.test(t)) return true;
  const norm = normalizeForFilter(t);
  for (const cat of GREYLIST_CATEGORIES) {
    if (normalizeForFilter(cat.canonicalTag) === norm) return true;
    if (cat.keywords.some(k => normalizeForFilter(k) === norm)) return true;
  }
  return false;
}

/** 属性/控制类 token：体型外观词、衣着词，加上控制与灰名单词。 */
export function isAttributeToken(token: string): boolean {
  const t = token.trim();
  return isControlOrGreylistToken(t) || t in FEATURE_DICT || t in COMMON_ATTR_MAP;
}

/** 静态词表里是否已收录该词（角色别名 / 衣着词 / 体型词） */
export function isStaticKnownToken(token: string): boolean {
  return token in CHARACTER_TAG_MAP || token in COMMON_ATTR_MAP || token in FEATURE_DICT;
}

/**
 * 只在「剩余部分是已收录的词」时才认可拆解（妃咲 ∈ 别名表）。
 * 剩余部分未知时不拆：美少女战士、小林家的龙女仆、姐姐大人 这类作品名/角色名/日常词整体才是正确单位。
 */
export function peelKnownCompound(token: string, isKnown: (t: string) => boolean = isStaticKnownToken): PeeledToken | null {
  const peeled = peelFeatureWords(token);
  if (!peeled) return null;
  // 同时试「剥连接字前」的剩余部分，避免 和泉纱雾 之类的人名被连接字吃掉首字
  const afterFeatures = token.replace(new RegExp(`^(?:${peeled.features.map(escapeRe).join("|")})+`), '');
  const candidates = [afterFeatures, peeled.rest].filter(Boolean);
  const hit = candidates.find(c => isKnown(c));
  return hit ? { features: peeled.features, rest: hit } : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从关键词里去掉灰名单词（r18 / 口交 / …）。用于「再来一张」的槽位：灰名单授权绝不跨轮继承，
 * 包括粘在角色名上的写法（r18龙华妃咲、ｒ１８龙华妃咲、口交妃咲）。
 */
export function stripGreylistWords(token: string): string {
  let t = normalizeForFilter(token);
  for (const cat of GREYLIST_CATEGORIES) {
    const words = [...cat.keywords, cat.canonicalTag].map(normalizeForFilter).filter(Boolean);
    // 长词优先，避免 r-18g 被 r-18 先吃掉后残留 g
    for (const w of words.sort((a, b) => b.length - a.length)) {
      t = t.split(w).join(' ');
    }
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 从一串关键词里挑出「主角色」：第一个非属性词（复合词先剥属性，剩余部分须是已收录词）。没有则返回 undefined。
 * 调用方应先对 tokens 做 stripGreylistWords。
 */
export function pickSubjectToken(tokens: string[], isKnown: (t: string) => boolean = isStaticKnownToken): string | undefined {
  for (const tok of tokens) {
    const peeled = peelKnownCompound(tok, isKnown);
    if (peeled) {
      if (!isAttributeToken(peeled.rest)) return peeled.rest;
      continue;
    }
    if (!isAttributeToken(tok)) return tok;
  }
  return undefined;
}
