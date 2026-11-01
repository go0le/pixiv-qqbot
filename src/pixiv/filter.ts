/**
 * Pixiv 作品质检清洗网与黑白灰名单过滤器 (v3.0 - Claude Opus 4.6 审查加固版)
 *
 * 核心机制与加固：
 * 1. Unicode 标准化 (NFKC) 与零宽字符清理，彻底防范全角/不可见字符绕过 (P2-01)
 * 2. 移除双向子串包含 `kwLower.includes(clean)`，根治裸前缀越权与误伤 (P0-02 / P1-03)
 * 3. 增强标题与画师级黑名单扫描，权威绑定 Pixiv aiType === 2 判定
 * 4. 灰名单全覆盖：不仅扫描 tags，同时扫描作品 title 防止标题违规漏网 (P2-03)
 * 5. 互斥实体组引入多人合绘白名单 (2人/3人/コラボ/crossover)，避免误杀 (P2-02)
 */
import {
  BLACKLIST_CATEGORIES,
  COLLECTION_TAGS,
  EXCLUSIVE_GROUPS,
  GREYLIST_CATEGORIES,
} from './constants.ts';
import type { CachedPixivMetadata, PixivIllustration } from './types.ts';

export interface BlacklistCheckResult {
  blocked: boolean;
  matchedTag?: string;
  categoryName?: string;
}

export interface FilterResult {
  compliant: boolean;
  reason?: string;
}

/**
 * 针对过滤检查的 Unicode 深度标准化与不可见字符清洗 (F-01 增强组合附标字符防御)
 */
export function normalizeForFilter(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFKD') // 分解预组合与组合变体字符 (如 ĺ -> l + \u0301)
    .replace(/[\u0300-\u036F]/g, '') // 剥离 Unicode 组合附标字符 (F-01)
    .normalize('NFKC') // 合并全角/半角等标准形式
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD]/g, '') // 移除零宽/控制字符
    .toLowerCase()
    .trim();
}


/**
 * 短关键词（≤2 个 ASCII 字符，如 "bl"）以及易误伤的短词（"腐"、"グロ"）只做整词匹配：
 * 文本整体相等，或按空白/标点切分后的某个片段相等。避免 blonde / table / グロス / 豆腐 被误杀。
 * 其余关键词保持正向子串包含。
 */
const STRICT_BLACKLIST_KEYWORDS = new Set(['腐', 'グロ']);
export function isStrictBlacklistKeyword(kwNorm: string): boolean {
  return /^[a-z0-9]{1,2}$/.test(kwNorm) || STRICT_BLACKLIST_KEYWORDS.has(kwNorm);
}
export function blacklistKeywordMatches(textNorm: string, kwNorm: string): boolean {
  if (!textNorm || !kwNorm) return false;
  if (!isStrictBlacklistKeyword(kwNorm)) return textNorm.includes(kwNorm);
  if (textNorm === kwNorm) return true;
  return textNorm.split(/[\s_\-\/・,，、.。:：;；!！?？()（）\[\]【】「」『』#＃+＋&＆|]+/u).some(part => part === kwNorm);
}

/**
 * 校验用户输入的关键词是否命中黑名单
 * 遵循严格的正向匹配（仅当输入完整等于黑名单词或包含完整黑名单词时触发）
 * 支持整句多词联合扫描，彻底杜绝空格拆分绕过复合词 (NF-03)
 */
export function checkRequestBlacklist(tokens: string[]): BlacklistCheckResult {
  // 1. 全文联合扫描：防范类似 "stable diffusion" 因空格被拆分为独立 token 而漏判 (NF-03)
  const joinedClean = normalizeForFilter(tokens.join(' '));
  if (joinedClean) {
    for (const cat of BLACKLIST_CATEGORIES) {
      for (const kw of cat.keywords) {
        const kwNorm = normalizeForFilter(kw);
        if (kwNorm.includes(' ') && joinedClean.includes(kwNorm)) {
          return {
            blocked: true,
            matchedTag: kw,
            categoryName: cat.name,
          };
        }
      }
    }
  }

  // 2. 逐 token 独立精确/正向包含扫描
  for (const token of tokens) {
    const clean = normalizeForFilter(token);
    if (!clean) continue;

    for (const cat of BLACKLIST_CATEGORIES) {
      for (const kw of cat.keywords) {
        const kwNorm = normalizeForFilter(kw);
        // 单向正向匹配：严禁使用 kwNorm.includes(clean)，防止输入单个英文字母误触发
        if (blacklistKeywordMatches(clean, kwNorm)) {
          return {
            blocked: true,
            matchedTag: token,
            categoryName: cat.name,
          };
        }
      }
    }
  }

  return { blocked: false };
}

/**
 * 从用户输入的关键词中提取已显式授权的灰名单类别 ID 集合
 * 遵循严格单向正向匹配，彻底杜绝输入前缀（如 "r1"）静默越权获取 R18 权限
 */
export function extractRequestedGreylist(tokens: string[]): Set<string> {
  const allowed = new Set<string>();

  for (const token of tokens) {
    const clean = normalizeForFilter(token);
    if (!clean) continue;

    for (const cat of GREYLIST_CATEGORIES) {
      for (const kw of cat.keywords) {
        const kwNorm = normalizeForFilter(kw);
        // 单向正向匹配
        if (clean === kwNorm || clean.includes(kwNorm)) {
          allowed.add(cat.id);
          break;
        }
      }
    }
  }

  return allowed;
}

/**
 * 判断作品是否包含黑名单内容（动图、AI、黑名单标签、标题或画师）
 */
export function checkImageBlacklist(
  illust: PixivIllustration | CachedPixivMetadata,
): FilterResult {
  // 1. 介质与 AI 生成作品权威拦截 (illustType === 2 动图, aiType === 2 Pixiv官方AI标记)
  if (illust.illustType === 2 || (illust as any).aiType === 2) {
    return {
      compliant: false,
      reason: '作品属于动图或 AI 生成内容 (illustType===2 或 aiType===2)',
    };
  }

  // 2. 标签黑名单扫描
  const tags = illust.tags || [];
  for (const tag of tags) {
    const tagNorm = normalizeForFilter(tag);
    for (const cat of BLACKLIST_CATEGORIES) {
      for (const kw of cat.keywords) {
        const kwNorm = normalizeForFilter(kw);
        if (blacklistKeywordMatches(tagNorm, kwNorm)) {
          return {
            compliant: false,
            reason: `作品命中黑名单标签「${tag}」（分类：${cat.name}）`,
          };
        }
      }
    }
  }

  // 3. 标题与画师名黑名单扫描 (kwNorm 至少 2 个有效字符防误伤)
  const titleNorm = normalizeForFilter(illust.title || '');
  const artistNorm = normalizeForFilter(illust.artist || '');
  for (const cat of BLACKLIST_CATEGORIES) {
    for (const kw of cat.keywords) {
      const kwNorm = normalizeForFilter(kw);
      if (kwNorm.length >= 2) {
        if (blacklistKeywordMatches(titleNorm, kwNorm)) {
          return {
            compliant: false,
            reason: `作品标题「${illust.title}」命中黑名单关键词「${kw}」（分类：${cat.name}）`,
          };
        }
        if (blacklistKeywordMatches(artistNorm, kwNorm) && (cat.id === 'ai' || cat.id === 'meme')) {
          return {
            compliant: false,
            reason: `画师名称「${illust.artist}」命中黑名单标识「${kw}」`,
          };
        }
      }
    }
  }

  return { compliant: true };
}

/**
 * 校验作品是否属于 Pixiv 官方标记的限制级 (xRestrict > 0)
 * 灰名单中画师标注的 r18 不算，严格以官方标注为准。
 * 鲁棒支持数值、字符串与缺省类型转换。
 */
export function isOfficialR18(
  illust: PixivIllustration | CachedPixivMetadata,
): boolean {
  if (!illust) return false;
  const val = Number((illust as any).xRestrict);
  return !Number.isNaN(val) && val > 0;
}

/**
 * 灰名单合规校验：
 * 只有用户显式请求了某灰名单类别，该类别的标签才允许放行；其余灰名单类别坚决拦截。
 * 同时覆盖标签 (tags) 与标题 (title)。
 * 注意：灰名单中画师标注的 r18 不算，r18 分类严格以官方标注 (xRestrict > 0) 为准。
 */
export function checkImageGreylist(
  illust: PixivIllustration | CachedPixivMetadata,
  allowedCategories: Set<string>,
): FilterResult {
  // 1. 若作品本身被官方标记为 R-18 / R-18G，必须显式授权了 'r18'
  // 注意：画师在 tags 或 title 标注的 r18 不算，要官方标注的 r18 (xRestrict > 0) 才算
  const isR18Work = isOfficialR18(illust);
  if (isR18Work && !allowedCategories.has('r18')) {
    return {
      compliant: false,
      reason: '作品属于 R-18 限制级，未在用户请求中显式放行',
    };
  }

  // 2. 检查作品携带的每一个 Tag 是否落在灰名单中
  const tags = illust.tags || [];
  for (const tag of tags) {
    const tagNorm = normalizeForFilter(tag);

    for (const cat of GREYLIST_CATEGORIES) {
      // 灰名单中画师标注的 r18 不算，r18 判定严格以官方标注 (xRestrict > 0) 为准，跳过 tag 中的 r18 校验
      if (cat.id === 'r18') continue;

      for (const kw of cat.keywords) {
        const kwNorm = normalizeForFilter(kw);
        if (tagNorm === kwNorm || tagNorm.includes(kwNorm)) {
          // 该标签属于灰名单分类 cat.id
          if (!allowedCategories.has(cat.id)) {
            return {
              compliant: false,
              reason: `作品含有未授权的灰名单标签「${tag}」（分类：${cat.name}）`,
            };
          }
        }
      }
    }
  }

  // 3. 检查作品标题是否含有未授权灰名单词（防止漏网）
  const titleNorm = normalizeForFilter(illust.title || '');
  for (const cat of GREYLIST_CATEGORIES) {
    // 灰名单中画师标注的 r18 不算，跳过标题中的 r18 校验
    if (cat.id === 'r18') continue;
    if (allowedCategories.has(cat.id)) continue;
    for (const kw of cat.keywords) {
      const kwNorm = normalizeForFilter(kw);
      if (kwNorm.length >= 2 && titleNorm.includes(kwNorm)) {
        return {
          compliant: false,
          reason: `作品标题「${illust.title}」含有未授权的灰名单敏感词「${kw}」（分类：${cat.name}）`,
        };
      }
    }
  }

  return { compliant: true };
}

/**
 * 校验作品是否切实满足指定的灰名单类别特征
 * 1. 若 categoryId === 'r18'：灰名单中画师标注的 r18 不算，要官方标注的 r18 (xRestrict > 0) 才算
 * 2. 其余灰名单类别：tags 或 title 包含对应分类的特征关键词
 */
export function matchesGreylistCategory(
  illust: PixivIllustration | CachedPixivMetadata,
  categoryId: string,
): boolean {
  if (categoryId === 'r18') {
    // 灰名单里画师标注的 r18 不算，要官方标注的 r18 才算
    return isOfficialR18(illust);
  }

  const cat = GREYLIST_CATEGORIES.find(c => c.id === categoryId);
  if (!cat) return false;

  const tags = illust.tags || [];
  for (const tag of tags) {
    const tagNorm = normalizeForFilter(tag);
    for (const kw of cat.keywords) {
      const kwNorm = normalizeForFilter(kw);
      if (tagNorm === kwNorm || tagNorm.includes(kwNorm)) {
        return true;
      }
    }
  }

  const titleNorm = normalizeForFilter(illust.title || '');
  for (const kw of cat.keywords) {
    const kwNorm = normalizeForFilter(kw);
    if (kwNorm.length >= 2 && titleNorm.includes(kwNorm)) {
      return true;
    }
  }

  return false;
}

/**
 * 校验作品是否满足用户显式请求的每一个灰名单分类
 * 当且仅当用户请求中显式包含了某灰名单（如 r18、oral），作品必须真正具备该特征，严禁全年龄/无关图冒充。
 */
export function checkRequestedGreylistMatched(
  illust: PixivIllustration | CachedPixivMetadata,
  requestedCategories: Set<string>,
): FilterResult {
  if (!requestedCategories || requestedCategories.size === 0) {
    return { compliant: true };
  }

  for (const catId of requestedCategories) {
    if (!matchesGreylistCategory(illust, catId)) {
      const cat = GREYLIST_CATEGORIES.find(c => c.id === catId);
      const name = cat ? cat.name : catId;
      return {
        compliant: false,
        reason: `用户显式请求了「${name}」，但作品不具备该限制级/特殊特征`,
      };
    }
  }

  return { compliant: true };
}

/**
 * 互斥实体组校验：
 * 若搜的是角色 A，而作品打满了同组角色 B、C 的 Tag，在非合集情况下判定为恶意蹭 Tag 剔除。
 */
export function checkExclusiveGroup(
  illust: PixivIllustration | CachedPixivMetadata,
  targetTag: string,
): FilterResult {
  const tags = illust.tags || [];

  // 合集与多角色合绘作品免除互斥检查 (COLLECTION_TAGS 包含 2人/コラボ 等)
  for (const tag of tags) {
    const tagNorm = normalizeForFilter(tag);
    for (const ct of COLLECTION_TAGS) {
      if (tagNorm === normalizeForFilter(ct)) {
        return { compliant: true };
      }
    }
  }

  const targetNorm = normalizeForFilter(targetTag);

  // 精准匹配组内成员（支持去括号核心词精确对齐，防短名泛匹配误杀 F-02）
  const matchMember = (memberNorm: string, tNorm: string): boolean => {
    if (memberNorm === tNorm) return true;
    const core = memberNorm.replace(/\([^)]+\)/g, '').trim();
    if (core && core === tNorm) return true;
    if (tNorm.includes(memberNorm)) return true;
    return false;
  };

  // 定位目标标签所在的互斥组
  for (const group of EXCLUSIVE_GROUPS) {
    const isTargetInGroup = group.some(member => {
      const ml = normalizeForFilter(member);
      return matchMember(ml, targetNorm);
    });

    if (isTargetInGroup) {
      // 检查当前作品是否包含了该组内的其他角色标签
      for (const member of group) {
        const ml = normalizeForFilter(member);
        // 排除当前被搜的角色自身
        if (matchMember(ml, targetNorm)) {
          continue;
        }

        const containsOther = tags.some(t => {
          const tl = normalizeForFilter(t);
          return tl === ml || tl.includes(ml);
        });

        if (containsOther) {
          return {
            compliant: false,
            reason: `作品同时包含同组互斥角色「${member}」，判定为蹭热度引流图`,
          };
        }
      }
    }
  }

  return { compliant: true };
}

/**
 * 综合质检清洗：黑名单 -> 灰名单受控放行 -> 显式灰名单特征满足 -> 互斥组纯度
 */
export function isImageCompliant(
  illust: PixivIllustration | CachedPixivMetadata,
  targetTag: string,
  allowedGreylist: Set<string>,
): FilterResult {
  // 1. 黑名单
  const blRes = checkImageBlacklist(illust);
  if (!blRes.compliant) return blRes;

  // 2. 灰名单受控放行（未授权的灰名单绝不放行）
  const glRes = checkImageGreylist(illust, allowedGreylist);
  if (!glRes.compliant) return glRes;

  // 3. 显式请求的灰名单必须切实满足（显式请求的灰名单绝不允许全年龄/无关图充数）
  const reqRes = checkRequestedGreylistMatched(illust, allowedGreylist);
  if (!reqRes.compliant) return reqRes;

  // 4. 互斥实体组纯度校验
  const exRes = checkExclusiveGroup(illust, targetTag);
  if (!exRes.compliant) return exRes;

  return { compliant: true };
}
