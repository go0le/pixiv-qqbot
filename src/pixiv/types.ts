/**
 * Pixiv 检索与投递能力的数据类型定义 (v2.0 规范)
 */

/** 单张 Pixiv 插画数据 */
export interface PixivIllustration {
  /** Pixiv 作品 ID (PID) */
  pid: string;
  /** 作品标题 */
  title: string;
  /** 画师名称 */
  artist: string;
  /** 本地缓存文件绝对路径 */
  localPath: string;
  /** 综合加权得分 */
  score: number;
  /** 收藏量 (Bookmarks) */
  bookmarks: number;
  /** 作品发布时间 (ISO 字符串) */
  uploadDate: string;
  /** 标签列表 */
  tags: string[];
  /** 原图下载链接 */
  originalUrl?: string;
  /** 是否来自本地缓存命中 */
  isFromCache: boolean;
  /** 联网检索时所属的质量档位（0=最高档）。排序时先看档位再看得分；本地缓存视为 0 */
  tierRank?: number;
  /** 作品页码（多页插画，从 0 开始，默认为 0） */
  page?: number;
  /** 作品介质类型：0=插画, 1=漫画, 2=动图(Ugoira) */
  illustType?: number;
  /** Pixiv 官方限制级别：0=全年龄, 1=R-18, 2=R-18G */
  xRestrict?: number;
  /** Pixiv 官方 AI 标记：2 = AI 生成 */
  aiType?: number;
}

/** Pixiv 检索结果 */
export interface PixivSearchResult {
  /** 检索出的插画列表 (已排序且满足数量要求) */
  illustrations: PixivIllustration[];
  /** 实际检索使用的标准化 Tag */
  tag: string;
  /** 用户原始输入关键词 */
  keyword: string;
  /** 是否触发历史耗尽重置兜底 */
  exhaustedReset?: boolean;
  /** 是否命中黑名单被系统拦截拒绝 */
  blocked?: boolean;
  /** 拦截拒绝的具体原因 */
  blockReason?: string;
  /** 结果为空时可以展示给用户的说明（例如没配登录态） */
  notice?: string;
  /** 0 结果后经 LLM 纠错重搜时的纠正说明（如 涼花ひより -> 涼海ひより） */
  corrected?: string;
}

/** 本地元数据缓存项 (对应 MEDIA_ROOT/pixiv_{PID}_p{PAGE} 的元信息) */
export interface CachedPixivMetadata {
  pid: string;
  title: string;
  artist: string;
  tags: string[];
  bookmarks: number;
  uploadDate: string;
  filePath: string;
  originalUrl: string;
  cachedAt: number;
  page?: number;
  illustType?: number;
  /** Pixiv 官方限制级别：0=全年龄, 1=R-18, 2=R-18G */
  xRestrict?: number;
  /** Pixiv 官方 AI 标记：2 = AI 生成 */
  aiType?: number;
}

/** Pixiv 模块全局配置 */
export interface PixivConfig {
  refreshToken?: string;
  searchProvider?: 'direct' | 'proxy';
  proxyBaseUrl?: string;
  searchRateLimit?: number;
  minBookmarks?: number;
  halfLifeDays?: number;
  baseBookmarkBias?: number;
  topK?: number;
  maxImagesPerRequest?: number;
  imageSendIntervalMs?: number;
  dedupWindowSize?: number;
  historyFlushIntervalMs?: number;
  resetCooldownMs?: number;
  mediaRoot?: string;
  cacheMaxSizeBytes?: number;
  cooldownMs?: number;
  globalMaxQpm?: number;
}
