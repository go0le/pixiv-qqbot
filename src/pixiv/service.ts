/**
 * Pixiv 插画检索与投递核心服务 (Pixiv Service v3.0)
 *
 * 核心升级：
 * 1. 实体映射与多 Tag 别名消歧 (CHARACTER_TAG_MAP / COMMON_ATTR_MAP)
 * 2. 黑名单强拦截：用户请求命中男同/猎奇/AI/福瑞等时，明文拒绝检索。
 * 3. 灰名单精准放行：默认杜绝 R18/口交等敏感玩法；仅当用户显式请求了特定灰名单标签时，精准放行该类别，其余灰名单依然严控。
 * 4. 互斥实体组纯度校验：严厉过滤同组多角色蹭 Tag 引流图。
 * 5. 缓存入库门禁：未通过质检网的作品坚决不入库、不落盘。
 * 6. 鲁棒半衰期时效性评分 + 边界钳位保护。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  CachedPixivMetadata,
  PixivConfig,
  PixivIllustration,
  PixivSearchResult,
} from './types.ts';
import { PixivHistoryManager, defaultPixivHistory } from './history.ts';
import { PixivRateLimiter, defaultPixivLimiter } from './limiter.ts';
import { KeyedMutex } from './mutex.ts';
import { DynamicTagStore } from './dynamic-store.ts';
import { LlmTagResolver } from './llm-resolver.ts';
import { PixivTagOracle } from './tag-oracle.ts';
import { FEATURE_DICT, peelFeatureWords, peelKnownCompound } from './compound.ts';
import {
  CHARACTER_TAG_MAP,
  COMMON_ATTR_MAP,
  GREYLIST_CATEGORIES,
  QUALITY_WATERFALL_TIERS,
  WORK_NAME_PREFIXES,
} from './constants.ts';
import {
  checkRequestBlacklist,
  extractRequestedGreylist,
  isImageCompliant,
  checkRequestedGreylistMatched,
  normalizeForFilter,
} from './filter.ts';
import {
  PixivAuth,
  PIXIV_APP_USER_AGENT,
  cookieHeader,
  hasPixivCredentials,
  readPixivCredentials,
  type SearchAuth,
} from './auth.ts';
import { buildIllustrationSearchUrl, extractSearchWorks, mapSearchWork } from './parse.ts';
import { PixivPrefsStore, resolvePrefsFile } from './prefs.ts';

/** 富媒体缓存目录 */
export const PIXIV_MEDIA_DIR = resolve(homedir(), '.dsh-qqbot', 'media');
/** 按会话的搜图偏好（QQ 机器人写，各 pixiv MCP 只读）：PIXIV_PREFS_FILE，默认和共享的已发历史放在一起 */
export const PIXIV_PREFS_FILE = resolvePrefsFile(resolve(homedir(), '.dsh-qqbot', 'pixiv-shared', 'pixiv_prefs.json'));
/** 本地元数据缓存文件 */
export const PIXIV_METADATA_FILE = resolve(homedir(), '.dsh-qqbot', 'pixiv_metadata.json');
/** 动态自学习标签映射存储文件 */
export const PIXIV_DYNAMIC_TAGS_FILE = resolve(homedir(), '.dsh-qqbot', 'pixiv_dynamic_tags.json');

/** 标准 User-Agent */
export const PIXIV_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 重新导出常量以便上层使用
export { CHARACTER_TAG_MAP };

// 全局单例停机钩子管理器 (F-03 避免多实例重复注册与相互覆盖)
let shutdownHooksRegistered = false;
const activeShutdownCallbacks = new Set<() => void>();

function ensureGlobalShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  // 先刷盘再把信号交还默认处理。不能在这里 process.exit(0)，否则插件会把整个 QQ 进程以成功码杀掉。
  const onShutdown = (signal: NodeJS.Signals) => {
    for (const cleanup of activeShutdownCallbacks) {
      try { cleanup(); } catch { /* ignore */ }
    }
    process.off(signal, onShutdown);
    process.kill(process.pid, signal);
  };
  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);
}

/**
 * 按真实收藏数分档：0 = ≥10000，1 = ≥5000，2 = ≥1000，3 = ≥500，4 = 更低。
 * 「users入り」是用户自己加的标签，有人给几十收藏的图也打上 10000users入り（实测 蕾姆 10000 档里有 51 收藏的），
 * 所以档位按真实收藏数算，而不是按它出现在哪个搜索档里。
 */
export function tierOfBookmarks(bookmarks: number): number {
  if (bookmarks >= 10000) return 0;
  if (bookmarks >= 5000) return 1;
  if (bookmarks >= 1000) return 2;
  if (bookmarks >= 500) return 3;
  return 4;
}
/** 每个质量档最多翻几页（每页 30 条）。前面的档翻完还不够才降档 */
const TIER_PAGES = Math.max(1, Math.min(5, Number(process.env.PIXIV_TIER_PAGES) || 2));
/** 「够好」的综合分下限（收藏数 × 时间衰减）。低于它的只在凑不够数时补位 */
export const MIN_GOOD_SCORE = Math.max(0, Number(process.env.PIXIV_MIN_SCORE ?? 100));
/**
 * 本地缓存直出的门槛：本地缓存里够数的候选综合分都达到它，才不联网直接从缓存发。
 * 否则联网，把缓存和网上的新候选放在一起按综合分挑——缓存里多是以前发过的老图，
 * 只看缓存会一直发老图（实测「蕾姆」缓存里全是 2021 年的高收藏图，网上有 2023–2024 年分数更高的）。
 */
const LOCAL_SHORTCUT_SCORE = Math.max(MIN_GOOD_SCORE, Number(process.env.PIXIV_LOCAL_SHORTCUT_SCORE ?? 1500));
/** 旧版本把未知收藏数抬成档位门槛写进了缓存，正好等于门槛值的缓存条目视为不可信 */
const INFLATED_BOOKMARKS = new Set([10000, 5000, 1000, 500]);

/** 半衰期常量: λ = ln(2) / 365 */
const LAMBDA_DECAY = Math.LN2 / 365;
/** 默认偏置 α */
const DEFAULT_BOOKMARK_BIAS = 10;
/** 最大衰减天数 */
const MAX_DELTA_DAYS = 3650;

/**
 * 计算 1 年半衰期时间衰减综合加权得分 (v2.0+ 鲁棒公式)
 *
 * Score = (Bookmarks + α) * exp(-λ * Δt)
 */
export function calculateTimeDecayScore(
  bookmarks: number,
  uploadDate: string | Date | number,
  now = Date.now(),
  alpha = DEFAULT_BOOKMARK_BIAS,
): number {
  const safeBookmarks = Math.max(0, Number.isFinite(bookmarks) ? bookmarks : 0);

  const dateMs =
    typeof uploadDate === 'number'
      ? uploadDate
      : typeof uploadDate === 'string'
        ? new Date(uploadDate).getTime()
        : uploadDate.getTime();

  if (Number.isNaN(dateMs) || dateMs <= 0) {
    return safeBookmarks + alpha;
  }

  // 钳位在 [0, 3650] 天：未来日期 Δt < 0 强制为 0，防止指数爆炸
  const rawDeltaDays = (now - dateMs) / (1000 * 60 * 60 * 24);
  const deltaDays = Math.max(0, Math.min(MAX_DELTA_DAYS, rawDeltaDays));

  const decay = Math.exp(-LAMBDA_DECAY * deltaDays);
  return (safeBookmarks + alpha) * decay;
}

export interface PixivServiceConfig {
  mediaDir?: string;
  metadataFile?: string;
  dynamicTagFile?: string;
  dynamicTagStore?: DynamicTagStore;
  llmTagResolver?: LlmTagResolver;
  historyManager?: PixivHistoryManager;
  rateLimiter?: PixivRateLimiter;
  timeoutMs?: number;
  config?: PixivConfig;
  /** 偏好文件；null = 只在内存里（测试用）；不传用 PIXIV_PREFS_FILE */
  prefsFile?: string | null;
}

/** 排行榜候选的缓存时长：日榜一天才更新一次，多个群同一时间推送时只请求一次 */
const RANKING_CACHE_MS = 30 * 60_000;

export class PixivService {
  private readonly mediaDir: string;
  private readonly metadataFile: string;
  private readonly metadataBackupFile: string;
  private readonly dynamicTagStore: DynamicTagStore;
  private readonly llmTagResolver: LlmTagResolver;
  private readonly tagOracle: PixivTagOracle;
  private readonly history: PixivHistoryManager;
  private readonly limiter: PixivRateLimiter;
  private readonly timeoutMs: number;
  private readonly chatMutex = new KeyedMutex();
  private readonly pixivAuth = new PixivAuth();
  private readonly cleanupFn: () => void;
  private readonly prefsStore: PixivPrefsStore;
  private readonly rankingCache = new Map<string, { at: number; items: Array<PixivIllustration & { rank: number }> }>();

  private metadataMap: Map<string, CachedPixivMetadata> = new Map();

  // 熔断控制
  private consecutiveFailures = 0;
  private circuitBreakUntil = 0;

  public constructor(config: PixivServiceConfig = {}) {
    this.mediaDir = config.mediaDir || PIXIV_MEDIA_DIR;
    this.metadataFile = config.metadataFile || PIXIV_METADATA_FILE;
    this.metadataBackupFile = `${this.metadataFile}.bak`;
    const dynamicFile = config.dynamicTagFile || PIXIV_DYNAMIC_TAGS_FILE;
    this.dynamicTagStore = config.dynamicTagStore || new DynamicTagStore({ filePath: dynamicFile });
    this.llmTagResolver = config.llmTagResolver || new LlmTagResolver({ timeoutMs: config.timeoutMs ?? 15000 });
    this.tagOracle = new PixivTagOracle({
      buildSearchAuth: () => this.buildSearchAuth(),
      fetchJson: (url, headers) => this.fetchJsonQuick(url, headers),
    });
    this.history = config.historyManager || defaultPixivHistory;
    this.limiter = config.rateLimiter || defaultPixivLimiter;
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.prefsStore = new PixivPrefsStore(config.prefsFile === undefined ? PIXIV_PREFS_FILE : config.prefsFile);
    this.ensureDirs();
    this.cleanStaleTemps();
    this.loadMetadata();

    // 接入全局单例停机钩子，多实例相互隔离 (F-03)
    ensureGlobalShutdownHooks();
    this.cleanupFn = () => {
      this.history.flushSync();
      this.saveMetadata(false);
      this.dynamicTagStore.save();
    };
    activeShutdownCallbacks.add(this.cleanupFn);
  }

  /**
   * 销毁服务实例，释放内存并注销停机清理钩子 (F-03)
   */
  public destroy(): void {
    activeShutdownCallbacks.delete(this.cleanupFn);
  }

  public get dynamicTags(): DynamicTagStore {
    return this.dynamicTagStore;
  }

  public get llmResolver(): LlmTagResolver {
    return this.llmTagResolver;
  }

  /** 按会话的搜图偏好（反馈、拉黑画师） */
  public get prefs(): PixivPrefsStore {
    return this.prefsStore;
  }

  /** 联网状态（给运行状况自检用）：连续失败次数、熔断到什么时候 */
  public networkState(): { consecutiveFailures: number; circuitBreakUntil: number } {
    return { consecutiveFailures: this.consecutiveFailures, circuitBreakUntil: this.circuitBreakUntil };
  }

  private ensureDirs(): void {
    if (!existsSync(this.mediaDir)) {
      mkdirSync(this.mediaDir, { recursive: true });
    }
  }

  /**
   * 启动时清理残留的 .tmp 临时文件 (P1-06)
   */
  public cleanStaleTemps(): void {
    try {
      if (!existsSync(this.mediaDir)) return;
      const files = readdirSync(this.mediaDir);
      const present = new Set(files);
      for (const f of files) {
        if (f.endsWith('.tmp')) {
          try { unlinkSync(join(this.mediaDir, f)); } catch { /* ignore */ }
          continue;
        }
        // 降噪成品 xxx.dn.jpg 的原图已不在（被淘汰/手工删除）时，成品一并清掉，避免孤儿文件堆积
        if (f.endsWith('.dn.jpg')) {
          const stem = f.slice(0, -'.dn.jpg'.length);
          const hasOriginal = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].some(ext => present.has(stem + ext));
          if (!hasOriginal) {
            try { unlinkSync(join(this.mediaDir, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch {
      // ignore
    }
  }



  private tryLoadMetadataFile(targetPath: string): boolean {
    if (!existsSync(targetPath)) return false;
    try {
      const raw = readFileSync(targetPath, 'utf8');
      const list = JSON.parse(raw) as CachedPixivMetadata[];
      if (!Array.isArray(list)) return false;
      this.metadataMap.clear();
      for (const item of list) {
        if (item && item.pid && existsSync(item.filePath)) {
          const key = `${item.pid}_p${item.page ?? 0}`;
          this.metadataMap.set(key, item);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从磁盘加载元数据缓存 (支持 .bak 自动容灾恢复 NF-04)
   */
  public loadMetadata(): void {
    if (this.tryLoadMetadataFile(this.metadataFile)) {
      return;
    }
    // 主文件损坏时自动尝试从 .bak 备份恢复 (NF-04)
    if (this.tryLoadMetadataFile(this.metadataBackupFile)) {
      try {
        this.saveMetadata(false);
      } catch {
        // ignore
      }
      return;
    }
    this.metadataMap.clear();
  }

  /**
   * 基于 LRU 淘汰旧缓存，保障磁盘空间可控 (NF-02 / P2-07 / F-07)
   */
  public evictOldCache(maxBytes = 2 * 1024 * 1024 * 1024): void {
    try {
      const entries = Array.from(this.metadataMap.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt); // 最久未访问的排最前

      let totalSize = 0;
      const sizeMap = new Map<string, number>();
      for (const [key, meta] of entries) {
        try {
          if (existsSync(meta.filePath)) {
            const size = statSync(meta.filePath).size;
            sizeMap.set(key, size);
            totalSize += size;
          }
        } catch {
          // ignore
        }
      }

      if (totalSize <= maxBytes) return;

      let evicted = false;
      for (const [key, meta] of entries) {
        if (totalSize <= maxBytes) break;
        try {
          if (existsSync(meta.filePath)) {
            unlinkSync(meta.filePath);
            totalSize -= sizeMap.get(key) ?? 0;
          }
          // 发送前生成的降噪成品跟随原图一起淘汰
          const derived = meta.filePath.replace(/\.[^./\\]+$/, '.dn.jpg');
          if (derived !== meta.filePath && existsSync(derived)) {
            try { totalSize -= statSync(derived).size; unlinkSync(derived); } catch { /* ignore */ }
          }
        } catch {
          // ignore
        }
        this.metadataMap.delete(key);
        evicted = true;
      }

      if (evicted) {
        this.saveMetadata(false); // 避免递归
      }
    } catch {
      // ignore
    }
  }

  /**
   * 原子化保存元数据到磁盘（带 .bak 容灾、tmp 异常清理与 LRU 自动触发 NF-02, NF-04）
   */
  public saveMetadata(shouldEvict = true): void {
    let tmpPath = '';
    try {
      const dir = this.mediaDir;
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 如果当前主元数据文件存在，先创建 .bak 备份容灾 (NF-04)
      if (existsSync(this.metadataFile)) {
        try {
          copyFileSync(this.metadataFile, this.metadataBackupFile);
        } catch {
          // ignore backup failure
        }
      }

      const list = Array.from(this.metadataMap.values());
      const serialized = JSON.stringify(list, null, 2);
      tmpPath = `${this.metadataFile}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, this.metadataFile);

      // 接入 LRU 淘汰检查，保障生产磁盘空间有界受控 (NF-02)
      if (shouldEvict) {
        this.evictOldCache();
      }
    } catch {
      if (tmpPath && existsSync(tmpPath)) {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 单个关键词标准化
   */
  public resolveSingleTag(keyword: string): string {
    let clean = keyword.trim();
    if (!clean) return clean;

    // 1. 检查角色映射
    if (CHARACTER_TAG_MAP[clean]) {
      return CHARACTER_TAG_MAP[clean]!;
    }

    // 2. 检查常见属性映射
    if (COMMON_ATTR_MAP[clean]) {
      return COMMON_ATTR_MAP[clean]!;
    }

    // 3. 检查自学习动态标签映射表
    const dynamicMatch = this.dynamicTagStore?.get(clean);
    if (dynamicMatch && dynamicMatch.length > 0) {
      return dynamicMatch[0]!;
    }

    // 4. 检查灰名单标准 Tag 映射（如 r18 -> R-18, 口交 -> フェラチオ，支持全角/Unicode 变体）
    const cleanNorm = normalizeForFilter(clean);
    for (const cat of GREYLIST_CATEGORIES) {
      for (const kw of cat.keywords) {
        if (cleanNorm === normalizeForFilter(kw)) {
          return cat.canonicalTag;
        }
      }
    }

    // 5. 去除常见前缀与后缀修饰
    const prefixes = WORK_NAME_PREFIXES;
    const suffixes = ['图片一张', '图片两张', '图片三张', '图片', '美图', '壁纸', '插画', '一张', '两张', '三张', '图'];
    for (const p of prefixes) {
      if (clean.toLowerCase().startsWith(p.toLowerCase()) && clean.length > p.length) {
        clean = clean.slice(p.length).trim();
        break;
      }
    }
    for (const s of suffixes) {
      if (clean.toLowerCase().endsWith(s.toLowerCase()) && clean.length > s.length) {
        clean = clean.slice(0, clean.length - s.length).trim();
        break;
      }
    }

    if (CHARACTER_TAG_MAP[clean]) {
      return CHARACTER_TAG_MAP[clean]!;
    }
    if (COMMON_ATTR_MAP[clean]) {
      return COMMON_ATTR_MAP[clean]!;
    }
    const dynAfterStrip = this.dynamicTagStore?.get(clean);
    if (dynAfterStrip && dynAfterStrip.length > 0) {
      return dynAfterStrip[0]!;
    }

    // 6. 大小写不敏感的整词匹配。不用子串包含，避免短角色名嵌进无关词后被错误映射。
    const lower = clean.toLowerCase();
    for (const [k, v] of Object.entries(CHARACTER_TAG_MAP)) {
      if (k.toLowerCase() === lower) return v;
    }

    return clean;
  }

  /**
   * 规范化用户输入的标签列表（同步查表快照）
   */
  public resolveTagList(input: string | string[]): string[] {
    const rawTokens = (Array.isArray(input) ? input : [input])
      .flatMap(i => i.trim().split(/\s+/))
      .filter(Boolean);

    return rawTokens.map(token => {
      // 人工维护的词典（角色别名、常见属性）优先于自学习动态表：动态表可能学到坏映射（如 女仆→ノエル(原神)）
      const curated = CHARACTER_TAG_MAP[token] ?? COMMON_ATTR_MAP[token];
      if (curated) return curated;
      const dyn = this.dynamicTagStore?.get(token);
      if (dyn && dyn.length > 0) return dyn.join(' ');
      return this.resolveSingleTag(token);
    });
  }

  /**
   * 异步智能解析标签列表：静态规则 + 动态自学习表 + LLM 语义回填持久化
   */
  /** 最长匹配切分：仅在整词被词典完全覆盖时返回（允许跳过「的/和/与」） */
  private segmentByDictionary(token: string): string[] | null {
    const dict: Record<string, string[]> = {};
    // 后写的覆盖先写的：动态表放最前，人工词典覆盖它
    for (const [k, v] of Object.entries(this.dynamicTagStore.getAll())) if (k.length <= 8) dict[k] = v;
    for (const [k, v] of Object.entries(FEATURE_DICT)) dict[k] = [v];
    for (const [k, v] of Object.entries(COMMON_ATTR_MAP)) dict[k] = [v];
    for (const [k, v] of Object.entries(CHARACTER_TAG_MAP)) dict[k] = [v];
    const keys = Object.keys(dict).sort((a, b) => b.length - a.length);
    const out: string[] = [];
    let i = 0;
    let pieces = 0;
    while (i < token.length) {
      const ch = token[i]!;
      if ('的和与跟'.includes(ch)) { i++; continue; }
      const k = keys.find(key => key.length >= 2 && token.startsWith(key, i));
      if (!k) return null;
      out.push(...dict[k]!);
      i += k.length;
      pieces++;
    }
    return pieces >= 2 ? Array.from(new Set(out)) : null;
  }

  /** 词是否已收录：静态别名/衣着/体型词，或动态自学习映射表 */
  private isKnownToken(t: string): boolean {
    return !!(CHARACTER_TAG_MAP[t] || COMMON_ATTR_MAP[t] || FEATURE_DICT[t] || this.dynamicTagStore?.get(t));
  }

  /**
   * 复合词拆解：「属性词 + 已收录词」无空格粘连时（如 巨乳妃咲）拆成 [妃咲, 巨乳]。
   * 剩余部分必须是已收录词才拆，否则整词保留：美少女战士、小林家的龙女仆、姐姐大人 拆开就是错的。
   * 已能整词解析的词也原样保留。
   *
   * @param aggressive 为 true 时剩余部分未收录也拆。只在整词搜不到结果后的兜底重试里使用。
   */
  public expandCompoundTokens(tokens: string[], aggressive = false): string[] {
    const out: string[] = [];
    for (const tok of tokens) {
      if (this.isKnownToken(tok)) { out.push(tok); continue; }
      const peeled = aggressive ? peelFeatureWords(tok) : peelKnownCompound(tok, t => this.isKnownToken(t));
      if (peeled) out.push(peeled.rest, ...peeled.features);
      else out.push(tok);
    }
    return Array.from(new Set(out));
  }

  public async resolveTagListAsync(input: string | string[]): Promise<string[]> {
    const rawTokens = this.expandCompoundTokens(
      (Array.isArray(input) ? input : [input])
        .flatMap(i => i.trim().split(/\s+/))
        .filter(Boolean),
    );

    if (rawTokens.length === 0) return [];

    const resolved: string[] = [];
    const unmappedIndices: number[] = [];
    const unmappedTokens: string[] = [];

    for (let i = 0; i < rawTokens.length; i++) {
      const token = rawTokens[i]!;

      // 0. 人工维护的角色别名表优先于自动学习的动态表：动态表里可能留着旧的坏映射（如 帝国→帝国）
      // 常见属性词（女仆、泳装…）同理：动态表里曾学到 女仆→ノエル(原神)
      const curated = CHARACTER_TAG_MAP[token] ?? COMMON_ATTR_MAP[token];
      if (curated) {
        resolved.push(curated);
        continue;
      }

      // 1. 优先查动态自学习映射表（中文短词须再过 Pixiv 校验，清掉历史坏映射如 祀→祭り）
      const dynamicMatch = this.dynamicTagStore?.get(token);
      if (dynamicMatch && dynamicMatch.length > 0) {
        const needsCheck = /[一-龥]/.test(token) && this.oracleEnabled();
        if (!needsCheck) {
          resolved.push(...dynamicMatch);
          continue;
        }
        const ctx = rawTokens.filter(t => t !== token);
        const ok: string[] = [];
        const failuresBefore = this.tagOracle.failures;
        for (const m of dynamicMatch) {
          if (await this.tagOracle.isValidMapping(token, m, ctx)) ok.push(m);
        }
        // 校验期间出现过网络失败：「不通过」不可信，保留已学到的映射，不改写也不删除
        if (this.tagOracle.failures > failuresBefore) {
          resolved.push(...dynamicMatch);
          continue;
        }
        if (ok.length > 0) {
          if (ok.join('\0') !== dynamicMatch.join('\0')) {
            this.dynamicTagStore.set(token, ok);
            this.dynamicTagStore.save();
          }
          resolved.push(...ok);
          continue;
        }
        this.dynamicTagStore.delete(token);
        this.dynamicTagStore.save();
        // 坏映射已删，落入后续 Pixiv/LLM 路径
      }

      // 2. 查静态规则字典与消歧表
      const staticMatch = this.resolveSingleTag(token);
      // 静态规则只剥掉了作品名前缀、剩余部分仍是中文短语时（如 崩铁的坏女人卡芙卡 -> 的坏女人卡芙卡），交给 LLM 处理整词
      if (staticMatch !== token && !(token.includes(staticMatch) && /[\u4e00-\u9fa5]/.test(staticMatch))) {
        resolved.push(staticMatch);
        continue;
      }

      // 3. 检查是否为包含中文自然语言描述的未收录词语/短语
      const hasChinese = /[\u4e00-\u9fa5]/.test(token);
      if (hasChinese) {
        // 先用本地词典 + 动态表做最长匹配切分（如 贫乳大姐姐 -> 貧乳 お姉さん），全覆盖则不调 LLM
        const seg = this.segmentByDictionary(token);
        if (seg) { resolved.push(...seg); continue; }
        unmappedIndices.push(resolved.length);
        unmappedTokens.push(token);
        resolved.push(token); // 占位
      } else {
        // 纯英文/假名/数字等已知标签（如 JK, original, R-18, アリス）直接放行
        resolved.push(token);
      }
    }

    // 全部命中或无未映射中文短语，直接返回（0ms 快速路径，不消耗大模型）
    if (unmappedTokens.length === 0) {
      return enforceBodyTags(rawTokens.join(' '), Array.from(new Set(resolved.filter(Boolean))));
    }

    // 未映射中文：优先 Pixiv 自动补全/共现推导；LLM 只作候选且必须通过 Pixiv 校验
    const fullInput = rawTokens.join(' ');
    const contextFor = (tok: string) => rawTokens.filter(t => t !== tok);

    for (let ui = 0; ui < unmappedTokens.length; ui++) {
      const token = unmappedTokens[ui]!;
      const idx = unmappedIndices[ui]!;
      const derived = this.oracleEnabled() ? await this.tagOracle.deriveFromPixiv(token, contextFor(token)) : [];
      if (derived.length > 0) {
        resolved[idx] = derived[0]!;
        // 多标签时追加到后面（少见）
        for (const extra of derived.slice(1)) {
          if (!resolved.includes(extra)) resolved.push(extra);
        }
        this.dynamicTagStore.set(token, derived);
        unmappedTokens[ui] = '';
        continue;
      }
    }

    const stillUnmapped = unmappedTokens.map((t, i) => ({ t, i })).filter(x => x.t);
    if (stillUnmapped.length === 0) {
      this.dynamicTagStore.save();
      return enforceBodyTags(rawTokens.join(' '), Array.from(new Set(resolved.filter(Boolean))));
    }

    const llmResult = await this.llmTagResolver.resolve(stillUnmapped.map(x => x.t), fullInput);

    if (llmResult && (llmResult.tags.length > 0 || Object.keys(llmResult.mappings || {}).length > 0)) {
      const filtered = this.oracleEnabled()
        ? await this.tagOracle.filterMappings(llmResult.mappings || {}, rawTokens)
        : (llmResult.mappings || {});
      if (Object.keys(filtered).length > 0) {
        this.dynamicTagStore.setBatch(filtered);
        this.dynamicTagStore.save();
      }

      for (const { t: originalToken, i: stillIdx } of stillUnmapped) {
        const resolvedIdx = unmappedIndices[stillIdx]!;
        const mapped = filtered[originalToken];
        if (mapped && mapped.length > 0) {
          resolved[resolvedIdx] = mapped[0]!;
          for (const extra of mapped.slice(1)) {
            if (!resolved.includes(extra)) resolved.push(extra);
          }
        }
        // 校验失败：保留原词（resolved 里已是占位原词）
      }

      return enforceBodyTags(rawTokens.join(' '), Array.from(new Set(resolved.filter(Boolean))));
    }

    // LLM 不可用或解析失败时的优雅降级：保留原分词
    return enforceBodyTags(rawTokens.join(' '), Array.from(new Set(resolved.filter(Boolean))));
  }

  /**
   * 规范化用户输入的标签字符串
   */
  public resolveTag(input: string | string[]): string {
    const list = this.resolveTagList(input);
    return list.join(' ');
  }

  /**
   * 检查会话是否在冷却期
   */
  public checkCooldown(chatKey: string): { allowed: boolean; remainingSec: number } {
    return this.limiter.check(chatKey);
  }

  /**
   * 消费一次冷却
   */
  public consumeCooldown(chatKey: string): { allowed: boolean; remainingSec: number } {
    return this.limiter.consume(chatKey);
  }

  /**
   * 获取指定会话已发送的历史 PID
   */
  public getSentPids(chatKey: string): Set<string> {
    return new Set(this.history.getSentPids(chatKey));
  }

  /**
   * 记录已发送的 PID
   */
  public recordSent(chatKey: string, pids: string[]): void {
    this.history.recordSent(chatKey, pids);
  }

  /**
   * 核心检索逻辑：带 chatKey 互斥锁保护，防并发踩踏
   */
  public async searchIllustrations(
    chatKey: string,
    keyword: string | string[],
    count = 1,
  ): Promise<PixivSearchResult> {
    return this.chatMutex.runExclusive(chatKey, async () => {
      const tokens = this.expandCompoundTokens(
        (Array.isArray(keyword) ? keyword : [keyword]).flatMap(k => k.trim().split(/\s+/)).filter(Boolean),
      );
      const dynBefore = this.dynamicTagStore.getAll();
      const first = await this.doSearchIllustrations(chatKey, tokens, count);
      if (first.illustrations.length > 0) console.log(`[PixivService] search "${tokens.join(' ')}" tags="${first.tag}" pids=${first.illustrations.map(x => x.pid).join(',')}`);
      if (first.blocked || first.illustrations.length > 0) return first;
      // 首次 0 结果：撤销本次请求新写入的（未经验证的）动态映射，避免缓存坏映射
      const dropNew = () => {
        const now = this.dynamicTagStore.getAll();
        let changed = false;
        for (const k of Object.keys(now)) {
          if (!(k in dynBefore)) { this.dynamicTagStore.delete(k); changed = true; }
          else if (JSON.stringify(now[k]) !== JSON.stringify(dynBefore[k])) { this.dynamicTagStore.set(k, dynBefore[k]!); changed = true; }
        }
        if (changed) this.dynamicTagStore.save();
      };
      dropNew();
      // 整词搜不到：把「属性词+未收录词」粘连的词强行拆开再试一次（剩余部分走映射/推导/纠错）
      const splitTokens = this.expandCompoundTokens(tokens, true);
      if (splitTokens.join(' ') !== tokens.join(' ')) {
        const viaSplit = await this.doSearchIllustrations(chatKey, splitTokens, count);
        if (viaSplit.blocked) return viaSplit;
        if (viaSplit.illustrations.length > 0) {
          console.log(`[PixivService] split fallback "${tokens.join(' ')}" -> "${splitTokens.join(' ')}"`);
          return { ...viaSplit, keyword: first.keyword, corrected: `拆分为「${splitTokens.join(' ')}」` };
        }
        dropNew();
      }
      if (process.env.PIXIV_LLM_TAGS !== '1' || process.env.PIXIV_LLM_CORRECT === '0') return first;
      // 只有纯数量/纯 R-18 开关算控制词；含灰名单词的特征词（如 贫乳大姐姐）仍需纠错
      const isControl = (t: string): boolean => /^\d+$/.test(t) || /^r-?18g?$/i.test(t);
      const featureTokens = tokens.filter(t => !isControl(t));
      if (featureTokens.length === 0) return first;
      const t0 = Date.now();
      // 标签过多导致 AND 搜不到时：保留前面的核心标签（角色通常在前），逐个去掉末尾的修饰标签再搜（最多 2 次）
      // 搜不到时的放宽：①去掉角色标签的「(作品名)」后缀（LLM 常写错格式）；②逐个去掉末尾修饰标签。最多 3 次额外搜索
      const relax = async (tagStr: string | undefined): Promise<PixivSearchResult | null> => {
        const all = (tagStr || '').split(/\s+/).filter(Boolean);
        const ctl = all.filter(isControl);
        const feat = all.filter(t => !isControl(t));
        const stripped = Array.from(new Set(feat.map(t => t.replace(/[(（][^()（）]*[)）]$/, '') || t)));
        const protectedTags = stripped.filter(t => PROTECTED_TAG_RE.test(t));
        const others = stripped.filter(t => !PROTECTED_TAG_RE.test(t));
        let plans: string[][] = [];
        if (stripped.join(' ') !== feat.join(' ')) plans.push(stripped);
        // 只丢非受保护的修饰标签；用户明说的体型/外观特征绝不静默丢弃
        for (let k = others.length - 1; k >= 0; k--) plans.push([...others.slice(0, k), ...protectedTags]);
        plans = plans.filter(p => p.length > 0 && protectedTags.every(t => p.includes(t)));
        // 始终保证尝试「只留第一个核心标签」（通常是角色名），避免 slice 上限漏掉
        if (stripped.length > 0 && !plans.some(p => p.length === 1 && p[0] === stripped[0])) {
          plans.push([stripped[0]!]);
        }
        for (const plan of plans.slice(0, 4)) {
          const tryTags = [...plan, ...ctl];
          const r = await this.doSearchIllustrations(chatKey, tryTags, count);
          if (r.blocked) return r;
          if (r.illustrations.length > 0) {
            console.log(`[PixivService] relaxed "${all.join(' ')}" -> "${tryTags.join(' ')}"`);
            return { ...r, keyword: first.keyword, corrected: `放宽为「${tryTags.join(' ')}」` };
          }
        }
        return null;
      };
      // 优先用 Pixiv 推导纠正；LLM 仅提供候选且逐项校验
      const pixivMapped: Record<string, string[]> = {};
      for (const t of featureTokens) {
        const derived = this.oracleEnabled() ? await this.tagOracle.deriveFromPixiv(t, featureTokens.filter(x => x !== t)) : [];
        if (derived.length > 0 && derived.join(' ') !== t) pixivMapped[t] = derived;
      }
      const corr = await this.llmTagResolver.correct(featureTokens, tokens.join(' '));
      const llmMapped = !corr ? {}
        : this.oracleEnabled() ? await this.tagOracle.filterMappings(corr.mappings || {}, featureTokens)
        : (corr.mappings || {});
      // 合并：Pixiv 推导优先于 LLM
      const merged: Record<string, string[]> = { ...llmMapped, ...pixivMapped };

      const newTokens: string[] = [];
      const applied: Record<string, string[]> = {};
      for (const t of tokens) {
        let m = !isControl(t) ? merged[t] : undefined;
        if (!m && !isControl(t) && featureTokens.length === 1 && corr && corr.tags.length > 0) {
          const filteredTags: string[] = [];
          for (const cand of corr.tags) {
            if (!this.oracleEnabled() || await this.tagOracle.isValidMapping(t, cand, featureTokens)) filteredTags.push(cand);
          }
          if (filteredTags.length) m = filteredTags;
        }
        if (m && m.length > 0) {
          newTokens.push(...m);
          if (m.join(' ') !== t) applied[t] = m;
        } else {
          newTokens.push(t);
        }
      }
      const uniq = enforceBodyTags(tokens.join(' '), Array.from(new Set(newTokens)));
      if (uniq.join(' ') === tokens.join(' ')) {
        console.log(`[PixivService] correction: no change for "${tokens.join(' ')}" (${Date.now() - t0}ms)`);
        return (await relax(first.tag)) ?? first;
      }
      console.log(`[PixivService] correction "${tokens.join(' ')}" -> "${uniq.join(' ')}" (${Date.now() - t0}ms)`);
      const second = await this.doSearchIllustrations(chatKey, uniq, count);
      if (second.blocked) return second;
      if (second.illustrations.length > 0) {
        if (Object.keys(applied).length > 0) {
          this.dynamicTagStore.setBatch(applied);
          this.dynamicTagStore.save();
        }
        const desc = Object.entries(applied).map(([k, v]) => `「${k}」→「${v.join(' ')}」`).join('，');
        console.log(`[PixivService] mapping applied: ${desc}`);
        return { ...second, keyword: first.keyword, corrected: desc || undefined };
      }

      // 纠正后仍 0：①原词再搜 ②纠正作品名 + 原始角色名
      const originalRetry = await this.doSearchIllustrations(chatKey, tokens, count);
      if (originalRetry.blocked) return originalRetry;
      if (originalRetry.illustrations.length > 0) {
        console.log(`[PixivService] fallback original tokens hit for "${tokens.join(' ')}"`);
        dropNew();
        return { ...originalRetry, keyword: first.keyword };
      }

      const hybrid2 = Array.from(new Set([
        ...uniq.filter(t => !featureTokens.includes(t)),
        ...featureTokens,
        ...tokens.filter(isControl),
      ]));
      if (hybrid2.join(' ') !== uniq.join(' ') && hybrid2.join(' ') !== tokens.join(' ')) {
        const third = await this.doSearchIllustrations(chatKey, hybrid2, count);
        if (third.blocked) return third;
        if (third.illustrations.length > 0) {
          console.log(`[PixivService] fallback hybrid "${tokens.join(' ')}" -> "${hybrid2.join(' ')}"`);
          dropNew();
          return { ...third, keyword: first.keyword };
        }
      }

      const relaxed = await relax(second.tag);
      if (relaxed && !relaxed.blocked && relaxed.illustrations.length > 0) return relaxed;
      const relaxedOrig = await relax(first.tag);
      if (relaxedOrig && !relaxedOrig.blocked && relaxedOrig.illustrations.length > 0) return relaxedOrig;
      dropNew();
      return first;
    });
  }

  private async doSearchIllustrations(
    chatKey: string,
    keyword: string | string[],
    count = 1,
  ): Promise<PixivSearchResult> {
    const rawKeywords = Array.isArray(keyword) ? keyword : [keyword];
    const tokens = rawKeywords
      .flatMap(k => k.trim().split(/\s+/))
      .filter(Boolean);

    const displayKeyword = tokens.join(' ');

    // 0. 黑名单拦截：若包含男同/猎奇/AI/福瑞等标签，不做回复并明文拒绝
    const blCheck = checkRequestBlacklist(tokens);
    if (blCheck.blocked) {
      return {
        illustrations: [],
        tag: displayKeyword,
        keyword: displayKeyword,
        blocked: true,
        blockReason: `请求包含禁止标签「${blCheck.matchedTag}」（黑名单分类：${blCheck.categoryName}），系统拒绝检索。`,
      };
    }

    // 1. 提取本次请求被显式允许的灰名单类别（其余灰名单严格避免）
    const allowedGreylist = extractRequestedGreylist(tokens);

    const targetCount = Math.max(1, Math.min(PIXIV_MAX_IMAGES, count)); // 单次上限 5 张（QQ 被动回复 5 条）
    const resolvedTags = await this.resolveTagListAsync(tokens);

    // 再次黑名单防线：若语义转换后的标签触发黑名单，坚决拦截
    const postBlCheck = checkRequestBlacklist(resolvedTags);
    if (postBlCheck.blocked) {
      return {
        illustrations: [],
        tag: displayKeyword,
        keyword: displayKeyword,
        blocked: true,
        blockReason: `语义转换后包含禁止标签「${postBlCheck.matchedTag}」（黑名单分类：${postBlCheck.categoryName}），系统拒绝检索。`,
      };
    }

    const tag = resolvedTags.join(' ');
    const sentPids = this.getSentPids(chatKey);

    // 2. 本地缓存检索（应用黑白灰名单与纯度质检网）
    const localMatches: PixivIllustration[] = [];
    const allLocalForTag: PixivIllustration[] = [];

    for (const meta of this.metadataMap.values()) {
      // 黑名单 / 互斥组 / 灰名单 / 多标签 AND，与网络候选共用同一套判断
      if (!this.passesRequestFilters(meta, tag, resolvedTags, tokens, allowedGreylist)) {
        continue;
      }
      if (existsSync(meta.filePath)) {
        const score = calculateTimeDecayScore(meta.bookmarks, meta.uploadDate);
        const illust: PixivIllustration = {
          pid: meta.pid,
          title: meta.title,
          artist: meta.artist,
          localPath: meta.filePath,
          score,
          bookmarks: meta.bookmarks,
          uploadDate: meta.uploadDate,
          tags: meta.tags,
          originalUrl: meta.originalUrl,
          isFromCache: true,
          page: meta.page ?? 0,
          illustType: meta.illustType ?? 0,
          xRestrict: Number(meta.xRestrict ?? 0),
          aiType: meta.aiType,
          tierRank: INFLATED_BOOKMARKS.has(Number(meta.bookmarks)) ? QUALITY_WATERFALL_TIERS.length : tierOfBookmarks(Number(meta.bookmarks) || 0),
        };
        if (INFLATED_BOOKMARKS.has(Number(meta.bookmarks))) illust.score = Math.min(illust.score, MIN_GOOD_SCORE - 1);
        allLocalForTag.push(illust);
        if (!sentPids.has(meta.pid)) {
          localMatches.push(illust);
        }
      }
    }

    // 同一作品的多页（p0/p1…）只保留得分最高的一页，避免一次回复里发出同一 PID 的多张
    const dedupeByPid = (list: PixivIllustration[]): PixivIllustration[] => {
      const best = new Map<string, PixivIllustration>();
      for (const it of list) {
        const cur = best.get(it.pid);
        if (!cur || it.score > cur.score) best.set(it.pid, it);
      }
      return Array.from(best.values());
    };
    localMatches.sort((a, b) => b.score - a.score);
    // 按会话偏好：去掉拉黑的画师/作品，综合分乘偏好系数（搜索词本身不参与），再重新排序
    const uniqueLocal = this.prefsStore.apply(chatKey, dedupeByPid(localMatches), resolvedTags);
    uniqueLocal.sort((a, b) => b.score - a.score);
    localMatches.length = 0;
    localMatches.push(...uniqueLocal);

    // 本地未看过、且够好的候选充足，直接抽选返回；否则联网找更好的（老图、低收藏图不算数）
    const goodLocal = localMatches.filter(m => m.score >= MIN_GOOD_SCORE);
    const excellentLocal = localMatches.filter(m => m.score >= LOCAL_SHORTCUT_SCORE);
    if (excellentLocal.length >= targetCount) {
      const selected = this.sampleTopK(excellentLocal, targetCount);
      // 命中缓存时更新 cachedAt 访问时间戳，将 FIFO 进阶为真正的 LRU (NF-05)
      const nowMs = Date.now();
      for (const s of selected) {
        const key = `${s.pid}_p${s.page ?? 0}`;
        const meta = this.metadataMap.get(key);
        if (meta) {
          meta.cachedAt = nowMs;
        }
      }
      this.saveMetadata(false);
      this.recordSent(chatKey, selected.map(s => s.pid));
      return {
        illustrations: selected,
        tag,
        keyword: displayKeyword,
      };
    }

    // 3. 本地不足，检查网络熔断状态，联网检索补充
    let exhaustedReset = false;
    let fetchedIllusts: PixivIllustration[] = [];

    const now = Date.now();
    const isCircuitBroken = now < this.circuitBreakUntil;

    if (!isCircuitBroken) {
      try {
        fetchedIllusts = await this.fetchFromNetwork(
          tag,
          allowedGreylist,
          resolvedTags,
          tokens,
          // 多备 2 个候选：有图下载失败时能补位，刚好够数的情况下也不至于少一张。只把够好的本地候选算进已有
          Math.max(1, targetCount - goodLocal.length) + 2,
          new Set([...sentPids, ...localMatches.map(m => m.pid)]),
        );
        fetchedIllusts = this.prefsStore.apply(chatKey, fetchedIllusts, resolvedTags);
        this.consecutiveFailures = 0; // 成功重置计数
      } catch {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= 5) {
          this.circuitBreakUntil = Date.now() + 5 * 60 * 1000; // 熔断 5 分钟
        }
      }
    }

    // 合并候选池并去重
    const candidatesMap = new Map<string, PixivIllustration>();
    for (const item of localMatches) {
      candidatesMap.set(item.pid, item);
    }
    for (const item of fetchedIllusts) {
      if (!sentPids.has(item.pid) && !candidatesMap.has(item.pid)) {
        candidatesMap.set(item.pid, item);
      }
    }

    // 先用「够好」的（综合分 = 真实收藏数 × 1 年半衰期，达到 MIN_GOOD_SCORE），再按综合分；
    // 不够好的只补缺口。档位（按真实收藏数）只在分数相同时决定先后
    const good = (x: PixivIllustration): number => (x.score >= MIN_GOOD_SCORE ? 0 : 1);
    const byTierThenScore = (a: PixivIllustration, b: PixivIllustration): number =>
      good(a) - good(b) || b.score - a.score || (a.tierRank ?? 4) - (b.tierRank ?? 4);
    let candidateList = Array.from(candidatesMap.values());
    candidateList.sort(byTierThenScore);

    // 4. 耗尽兜底（防循环刷屏：需校验 120 秒冷却）
    if (candidateList.length === 0) {
      if (this.history.canReset(chatKey)) {
        // 只让「本次检索范围内」的作品重新可发；不清掉这个会话其它标签的已发记录
        const pool = dedupeByPid([...this.prefsStore.apply(chatKey, allLocalForTag, resolvedTags), ...fetchedIllusts]);
        this.history.forget(chatKey, pool.map(p => p.pid));
        exhaustedReset = true;
        for (const item of pool) {
          candidatesMap.set(item.pid, item);
        }
        candidateList = Array.from(candidatesMap.values());
        candidateList.sort(byTierThenScore);
      }
    }

    if (candidateList.length === 0) {
      return {
        illustrations: [],
        tag,
        keyword: displayKeyword,
        exhaustedReset,
        ...this.authNotice(0, allowedGreylist),
      };
    }

    // 5. 采样指定数量：在够好的候选里按 Top-K 随机抽取，其余候选排在后面作为补位
    const goodCandidates = candidateList.filter(c => c.score >= MIN_GOOD_SCORE);
    const chosen = this.sampleTopK(goodCandidates.length >= targetCount ? goodCandidates : candidateList, targetCount);
    const chosenSet = new Set(chosen);
    const queue = [...chosen, ...candidateList.filter(c => !chosenSet.has(c))];

    // 6. 缓存入库门禁：确保选中的图片原图已下载，并通过完整性校验与质检网落盘。
    // 某张下载/校验失败时用后备候选补位，保证尽量凑够用户要求的数量。
    const finalized: PixivIllustration[] = [];
    let updatedLocalCache = false;
    // 补位次数设上限：下载全部失败时（pximg 断网/403）不能把整个候选池逐个试一遍
    const maxAttempts = targetCount + 3;
    let attempts = 0;
    let consecutiveDownloadFailures = 0;
    for (const item of queue) {
      if (finalized.length >= targetCount) break;
      if (attempts >= maxAttempts || consecutiveDownloadFailures >= 3) break;
      if (item.localPath && existsSync(item.localPath)) {
        finalized.push(item);
        // 本地缓存命中时同步刷新 cachedAt 时间戳 (NF-05)
        const key = `${item.pid}_p${item.page ?? 0}`;
        const meta = this.metadataMap.get(key);
        if (meta) {
          meta.cachedAt = Date.now();
          updatedLocalCache = true;
        }
      } else if (item.originalUrl) {
        try {
          // 再次确保合规
          const comp = isImageCompliant(item, tag, allowedGreylist);
          if (!comp.compliant) {
            continue;
          }

          attempts++;
          const downloadedPath = await this.downloadOriginalImage(
            item.pid,
            item.originalUrl,
            item.page ?? 0,
          );
          consecutiveDownloadFailures = 0;
          item.localPath = downloadedPath;
          const cacheKey = `${item.pid}_p${item.page ?? 0}`;
          this.metadataMap.set(cacheKey, {
            pid: item.pid,
            title: item.title,
            artist: item.artist,
            tags: item.tags,
            bookmarks: item.bookmarks,
            uploadDate: item.uploadDate,
            filePath: downloadedPath,
            originalUrl: item.originalUrl,
            cachedAt: Date.now(),
            page: item.page ?? 0,
            illustType: item.illustType ?? 0,
            xRestrict: Number(item.xRestrict ?? 0),
            aiType: item.aiType,
          });
          this.saveMetadata();
          finalized.push(item);
        } catch {
          // 下载或校验失败跳过该候选
          consecutiveDownloadFailures++;
        }
      }
    }

    if (updatedLocalCache) {
      this.saveMetadata(false);
    }

    // 登记已发送名单
    this.recordSent(chatKey, finalized.map(f => f.pid));

    return {
      illustrations: finalized,
      tag,
      keyword: displayKeyword,
      exhaustedReset,
      ...this.authNotice(finalized.length, allowedGreylist),
    };
  }

  /** 明文 R-18 但没配登录态时，空结果多半是 Pixiv 拒绝，而不是标签真的没有图。 */
  private authNotice(found: number, allowedGreylist: Set<string>): { notice?: string } {
    if (found > 0 || !allowedGreylist.has('r18')) return {};
    if (hasPixivCredentials()) return {};
    return {
      notice: 'R-18 搜索需要 Pixiv 登录凭据（PIXIV_REFRESH_TOKEN 或 PIXIV_PHPSESSID），未配置时 Pixiv 通常直接返回空结果。',
    };
  }

  /**
   * 本地缓存和网络候选共用：黑名单、互斥组蹭标签、灰名单，以及普通标签 AND。
   */
  private passesRequestFilters(
    meta: CachedPixivMetadata,
    searchTag: string,
    resolvedTags: string[],
    rawTokens: string[],
    allowedGreylist: Set<string>,
  ): boolean {
    const compliance = isImageCompliant(meta, searchTag, allowedGreylist);
    if (!compliance.compliant) return false;
    return this.matchMetadataTags(meta, resolvedTags, rawTokens, allowedGreylist);
  }

  /**
   * 普通标签 AND：每一个实质性映射标签都要在作品标签或标题里命中。
   * 灰名单标签从 AND 集合里拿掉，改由 checkRequestedGreylistMatched 强制命中，避免“点名了却被当成可有可无”。
   * 只按整词判断是不是灰名单，避免一个普通标签里夹了短词就被从 AND 里删掉。
   */
  private matchMetadataTags(
    meta: CachedPixivMetadata,
    resolvedTags: string[],
    rawTokens: string[],
    allowedGreylist: Set<string> = new Set(),
  ): boolean {
    // 1. 若用户显式请求了灰名单类别（如 r18 / 口交 等）：
    // 强制校验作品必须满足用户显式请求的每一个灰名单分类，严禁全年龄图充数冒领
    if (allowedGreylist.size > 0) {
      const reqCheck = checkRequestedGreylistMatched(meta, allowedGreylist);
      if (!reqCheck.compliant) {
        return false;
      }
    }

    const metaTagsLower = (meta.tags || []).filter((t): t is string => typeof t === 'string').map(t => t.toLowerCase());
    const metaTitleLower = (meta.title || '').toLowerCase();

    const greylistExact = new Set(
      GREYLIST_CATEGORIES.flatMap(cat => [
        ...cat.keywords.map(k => normalizeForFilter(k)),
        normalizeForFilter(cat.canonicalTag),
      ]),
    );
    // rawTokens 保留给调用方对齐；灰名单身份只看映射后的标签本身，不再用子串去蹭。
    void rawTokens;

    const substantiveTags: string[] = [];
    for (const rt of resolvedTags) {
      if (greylistExact.has(normalizeForFilter(rt))) continue;
      substantiveTags.push(rt.toLowerCase());
    }

    if (substantiveTags.length === 0) {
      // 若全为灰名单词（如用户只搜了 "r18"），只要通过上述显式灰名单校验就允许
      return true;
    }

    // 所有实质性词均需命中（在 tags 或 title 中出现）
    return substantiveTags.every(reqTag => {
      const coreName = reqTag.replace(/\([^)]+\)/g, '').trim();
      return (
        metaTagsLower.some(t => t === reqTag || t.includes(reqTag) || (coreName.length >= 2 && t.includes(coreName)))
        || metaTitleLower.includes(reqTag)
        || (coreName.length >= 2 && metaTitleLower.includes(coreName))
      );
    });
  }

  /**
   * Fisher-Yates 公平无偏洗牌算法 (P3-04)
   */
  private shuffleArray<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = a[i]!;
      a[i] = a[j]!;
      a[j] = temp;
    }
    return a;
  }

  /**
   * Top-K 随机采样 (基于无偏 Fisher-Yates 洗牌)
   */
  private sampleTopK(list: PixivIllustration[], count: number): PixivIllustration[] {
    if (list.length <= count) {
      return [...list];
    }
    if (count === 1) {
      const poolSize = Math.min(3, list.length);
      const randIdx = Math.floor(Math.random() * poolSize);
      return [list[randIdx]!];
    }

    const poolSize = Math.min(count + 2, list.length);
    const pool = list.slice(0, poolSize);
    const shuffled = this.shuffleArray(pool);
    return shuffled.slice(0, count);
  }

  private async buildSearchAuth(): Promise<SearchAuth> {
    const creds = readPixivCredentials();
    const headers: Record<string, string> = {
      'User-Agent': PIXIV_USER_AGENT,
      Referer: 'https://www.pixiv.net/',
    };
    const cookie = cookieHeader(creds);
    if (cookie) headers.Cookie = cookie;

    if (!creds.refreshToken) {
      return { headers, appApi: false, proxyBaseUrl: creds.proxyBaseUrl };
    }

    try {
      const token = await this.pixivAuth.getAccessToken(creds.refreshToken, this.timeoutMs);
      // 设了网页反代时仍走反代上的 AJAX；没设反代才改打 app-api。
      if (creds.proxyBaseUrl) {
        return { headers, appApi: false, proxyBaseUrl: creds.proxyBaseUrl };
      }
      return {
        appApi: true,
        proxyBaseUrl: '',
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          'User-Agent': PIXIV_APP_USER_AGENT,
          'App-OS': 'android',
          'App-OS-Version': '14.0.0',
          'App-Version': '6.127.0',
        },
      };
    } catch (err) {
      console.warn(`[pixiv] refresh token 失败，改走网页搜索: ${err instanceof Error ? err.message : 'unknown'}`);
      return { headers, appApi: false, proxyBaseUrl: creds.proxyBaseUrl };
    }
  }

  /**
   * 标签推导/校验用的轻量请求：单次、短超时、遵守熔断，失败计入连续失败数。
   * 搜图本身可以慢慢重试，但标签校验是搜图前的附加步骤，网络不通时不能把一条消息拖成分钟级。
   */
  private async fetchJsonQuick(url: string, headers: Record<string, string>): Promise<unknown> {
    if (Date.now() < this.circuitBreakUntil) throw new Error('Pixiv 熔断中，跳过标签校验请求');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 6000));
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) throw new Error(`Pixiv HTTP ${resp.status}`);
      const json = await resp.json();
      this.consecutiveFailures = 0;
      return json;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 5) this.circuitBreakUntil = Date.now() + 5 * 60 * 1000;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 是否用 Pixiv 自动补全/搜索共现来推导与校验标签。
   * PIXIV_TAG_ORACLE=1/0 显式开关；未设置时跟随 PIXIV_LLM_TAGS（不开 LLM 纠错就不额外联网）。
   */
  private oracleEnabled(): boolean {
    const v = process.env.PIXIV_TAG_ORACLE;
    if (v === '1') return true;
    if (v === '0') return false;
    return process.env.PIXIV_LLM_TAGS === '1';
  }

  /** 429 / 5xx 指数退避，最多 3 次。401/403 不重试，直接说明要凭据。 */
  private async fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const resp = await fetch(url, { headers, signal: controller.signal });
        if (resp.status === 429 || resp.status === 502 || resp.status === 503 || resp.status === 504) {
          lastError = new Error(`Pixiv search HTTP ${resp.status}`);
          continue;
        }
        if (resp.status === 401 || resp.status === 403) {
          throw new Error(`Pixiv 拒绝访问 HTTP ${resp.status}（检查 PIXIV_REFRESH_TOKEN / PIXIV_PHPSESSID，或代理是否可用）`);
        }
        if (!resp.ok) {
          throw new Error(`Pixiv search HTTP ${resp.status}`);
        }
        return await resp.json();
      } catch (err) {
        if (err instanceof Error && (err.message.startsWith('Pixiv 拒绝访问') || err.message.startsWith('Pixiv search HTTP'))) {
          throw err;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error('Pixiv search failed');
  }

  /**
   * 单次搜索。网络候选走和本地缓存相同的 passesRequestFilters（AND + 灰名单 + 互斥组 + 黑名单）。
   */
  private async fetchFromNetworkSingleQuery(
    queryTag: string,
    baseTag: string,
    minScoreBias: number,
    allowedGreylist: Set<string>,
    auth: SearchAuth,
    resolvedTags: string[],
    rawTokens: string[],
    page = 1,
    fetchTierRank = QUALITY_WATERFALL_TIERS.length,
  ): Promise<PixivIllustration[] & { rawCount?: number }> {
    const wantsR18 = allowedGreylist.has('r18');
    const searchUrl = buildIllustrationSearchUrl(queryTag, {
      wantsR18,
      appApi: auth.appApi,
      proxyBaseUrl: auth.proxyBaseUrl,
      page,
    });
    const json = await this.fetchJson(searchUrl, auth.headers);
    const rows = extractSearchWorks(json);
    // 只有网页 mode=r18 能在字段缺失时视为官方 R-18。app-api 不带 for_ios 时安全图和 R-18 混在一起，缺字段不能猜。
    const assumeMissingIsR18 = wantsR18 && !auth.appApi;

    const results: PixivIllustration[] = [];
    for (const row of rows) {
      const mapped = mapSearchWork(row, assumeMissingIsR18);
      if (!mapped) continue;

      // 收藏数已知就用真实值；只有接口没给（网页搜索）时才用所在档位的门槛估计
      const effectiveBookmarks = mapped.bookmarksKnown ? mapped.bookmarks : Math.max(mapped.bookmarks, minScoreBias);
      const meta: CachedPixivMetadata = {
        pid: mapped.pid,
        title: mapped.title,
        artist: mapped.artist,
        tags: mapped.tags,
        bookmarks: effectiveBookmarks,
        uploadDate: mapped.uploadDate,
        filePath: '',
        originalUrl: mapped.originalUrl ?? '',
        cachedAt: 0,
        page: 0,
        illustType: mapped.illustType,
        xRestrict: mapped.xRestrict,
        aiType: mapped.aiType,
      };
      if (resolvedTags.length > 0 && !this.passesRequestFilters(meta, baseTag, resolvedTags, rawTokens, allowedGreylist)) {
        continue;
      }
      if (resolvedTags.length === 0) {
        const compliance = isImageCompliant(meta, baseTag, allowedGreylist);
        if (!compliance.compliant) continue;
      }

      results.push({
        pid: mapped.pid,
        title: mapped.title,
        artist: mapped.artist,
        localPath: '',
        score: calculateTimeDecayScore(effectiveBookmarks, mapped.uploadDate),
        bookmarks: effectiveBookmarks,
        uploadDate: mapped.uploadDate,
        tags: mapped.tags,
        originalUrl: mapped.originalUrl,
        isFromCache: false,
        page: 0,
        illustType: mapped.illustType,
        xRestrict: mapped.xRestrict,
        aiType: mapped.aiType,
        tierRank: mapped.bookmarksKnown ? tierOfBookmarks(mapped.bookmarks) : fetchTierRank,
      });
    }
    return Object.assign(results, { rawCount: rows.length });
  }

  /**
   * 质量阶梯漏斗：10000 → 5000 → 1000 → 500 users入り，最后才用纯标签。
   * resolvedTags / rawTokens 传给每一档，避免网络结果绕过 AND。
   * 上一档候选不够（want 张都凑不满）时继续往下一档补，而不是只拿第一档就停，
   * 否则用户要 5 张、最高档只有 2 张时会只返回 2 张。
   */
  private async fetchFromNetwork(
    tag: string,
    allowedGreylist: Set<string>,
    resolvedTags: string[] = [],
    rawTokens: string[] = [],
    want = 1,
    exclude: Set<string> = new Set(),
  ): Promise<PixivIllustration[]> {
    const auth = await this.buildSearchAuth();
    const target = Math.max(1, want);
    const pool = new Map<string, PixivIllustration>();
    const absorb = (items: PixivIllustration[], tierRank: number): void => {
      for (const it of items) if (!pool.has(it.pid)) pool.set(it.pid, { ...it, tierRank: it.tierRank ?? tierRank });
    };
    // 够好的新候选（没发过、综合分达标）。只数够好的：老图、刷标签的低收藏图不算数，不够就继续翻页/降档
    const goodFresh = (): number => {
      let n = 0;
      for (const [pid, it] of pool) if (!exclude.has(pid) && it.score >= MIN_GOOD_SCORE) n++;
      return n;
    };

    // 查询顺序：每一轮把各档的下一页各查一次（10000 p1 → 5000 p1 → 1000 p1 → 500 p1 → 10000 p2 → …）。
    // 至少看完前两档的第 1 页才允许提前结束，这样选图时新一点的 5000 档作品能和老的 10000 档作品比综合分。
    const exhausted = new Set<number>();
    let steps = 0;
    outer: for (let page = 1; page <= TIER_PAGES; page++) {
      for (const [tierIdx, tier] of QUALITY_WATERFALL_TIERS.entries()) {
        if (exhausted.has(tierIdx)) continue;
        let rawCount = 0;
        try {
          const items = await this.fetchFromNetworkSingleQuery(
            `${tag} ${tier.suffix}`,
            tag,
            tier.minScoreBias,
            allowedGreylist,
            auth,
            resolvedTags,
            rawTokens,
            page,
            tierIdx,
          );
          rawCount = items.rawCount ?? items.length;
          absorb(items, tierIdx);
        } catch {
          exhausted.add(tierIdx); // 这一档出错就不再查
          continue;
        }
        steps++;
        if (rawCount < 30) exhausted.add(tierIdx); // 这一档没有更多了
        if (steps >= 2 && goodFresh() >= target) break outer;
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (goodFresh() >= target) return Array.from(pool.values());
    try {
      absorb(await this.fetchFromNetworkSingleQuery(tag, tag, 0, allowedGreylist, auth, resolvedTags, rawTokens, 1, QUALITY_WATERFALL_TIERS.length), QUALITY_WATERFALL_TIERS.length);
    } catch (err) {
      // 各档都已有结果时忽略最后一档的失败；一无所获才把错误抛给上层计入熔断
      if (pool.size === 0) throw err;
    }
    return Array.from(pool.values());
  }

  /**
   * 每日一图：从 Pixiv 排行榜（默认日榜）里给这个会话挑一张没发过、合规、合偏好的插画，下载好并记进已发历史。
   * 只看全年龄榜，灰名单一律不放行（白名单会话也一样）；名次靠前的优先，偏好只在相近名次之间调整先后。
   * 没有可发的返回 null；网络错误照常抛出。
   */
  public async pickRanking(
    chatKey: string,
    opts: { mode?: 'day' | 'week'; maxRank?: number } = {},
  ): Promise<{ illust: PixivIllustration; rank: number; mode: 'day' | 'week' } | null> {
    const mode = opts.mode ?? 'day';
    const maxRank = Math.max(1, Math.min(50, Math.floor(opts.maxRank ?? 30)));
    return this.chatMutex.runExclusive(chatKey, async () => {
      const ranked = await this.fetchRanking(mode);
      const sent = this.getSentPids(chatKey);
      // 名次分：第 1 名 1.0，第 15 名约 0.64；乘上偏好系数后排序
      const pool = ranked
        .filter(it => it.rank <= maxRank && !sent.has(it.pid))
        .map(it => ({ ...it, score: 1 / (1 + 0.04 * (it.rank - 1)) }));
      const candidates = this.prefsStore.apply(chatKey, pool, []).sort((a, b) => b.score - a.score || a.rank - b.rank);
      let attempts = 0;
      for (const item of candidates) {
        if (attempts >= 3) break;
        if (!item.originalUrl) continue;
        attempts++;
        try {
          const localPath = await this.downloadOriginalImage(item.pid, item.originalUrl, 0);
          this.metadataMap.set(`${item.pid}_p0`, {
            pid: item.pid,
            title: item.title,
            artist: item.artist,
            tags: item.tags,
            bookmarks: item.bookmarks,
            uploadDate: item.uploadDate,
            filePath: localPath,
            originalUrl: item.originalUrl,
            cachedAt: Date.now(),
            page: 0,
            illustType: item.illustType ?? 0,
            xRestrict: Number(item.xRestrict ?? 0),
            aiType: item.aiType,
          });
          this.saveMetadata();
          this.recordSent(chatKey, [item.pid]);
          const { rank, ...illust } = item;
          return { illust: { ...illust, localPath }, rank, mode };
        } catch (err) {
          console.warn(`[PixivService] ranking pick pid=${item.pid} download failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      return null;
    });
  }

  /** 排行榜第一页（30 条）里合规的插画，带名次。有 refresh token 走 app-api，否则走网页 ranking.php */
  private async fetchRanking(mode: 'day' | 'week'): Promise<Array<PixivIllustration & { rank: number }>> {
    const hit = this.rankingCache.get(mode);
    if (hit && Date.now() - hit.at < RANKING_CACHE_MS) return hit.items;
    const auth = await this.buildSearchAuth();
    let rows: Record<string, unknown>[];
    if (auth.appApi) {
      rows = extractSearchWorks(await this.fetchJson(`https://app-api.pixiv.net/v1/illust/ranking?mode=${mode}&filter=for_android`, auth.headers));
    } else {
      const origin = (auth.proxyBaseUrl || 'https://www.pixiv.net').replace(/\/$/, '');
      const json = await this.fetchJson(`${origin}/ranking.php?mode=${mode === 'day' ? 'daily' : 'weekly'}&content=illust&format=json&p=1`, auth.headers) as { contents?: unknown };
      const contents = Array.isArray(json?.contents) ? json.contents as Record<string, unknown>[] : [];
      rows = contents.map(c => {
        const ct = (c.illust_content_type ?? {}) as Record<string, unknown>;
        const flagged = ['bl', 'furry', 'grotesque', 'homosexual'].some(k => ct[k] === true) || Number(ct.sexual ?? 0) > 0;
        return {
          id: c.illust_id,
          title: c.title,
          userName: c.user_name,
          tags: c.tags,
          url: c.url,
          createDate: typeof c.illust_upload_timestamp === 'number' ? new Date(c.illust_upload_timestamp * 1000).toISOString() : undefined,
          illustType: Number(c.illust_type ?? 0),
          xRestrict: flagged ? 1 : 0,
          aiType: c.illust_ai_type ?? 0,
        };
      });
    }
    const items: Array<PixivIllustration & { rank: number }> = [];
    rows.forEach((row, i) => {
      const mapped = mapSearchWork(row, false);
      if (!mapped || mapped.illustType !== 0) return;
      const meta: CachedPixivMetadata = {
        pid: mapped.pid,
        title: mapped.title,
        artist: mapped.artist,
        tags: mapped.tags,
        bookmarks: mapped.bookmarks,
        uploadDate: mapped.uploadDate,
        filePath: '',
        originalUrl: mapped.originalUrl ?? '',
        cachedAt: 0,
        page: 0,
        illustType: mapped.illustType,
        xRestrict: mapped.xRestrict,
        aiType: mapped.aiType,
      };
      if (!isImageCompliant(meta, '', new Set()).compliant) return;
      items.push({
        pid: mapped.pid,
        title: mapped.title,
        artist: mapped.artist,
        localPath: '',
        score: 0,
        bookmarks: mapped.bookmarks,
        uploadDate: mapped.uploadDate,
        tags: mapped.tags,
        originalUrl: mapped.originalUrl,
        isFromCache: false,
        page: 0,
        illustType: mapped.illustType,
        xRestrict: mapped.xRestrict,
        aiType: mapped.aiType,
        rank: i + 1,
      });
    });
    if (items.length > 0) this.rankingCache.set(mode, { at: Date.now(), items });
    return items;
  }

  /**
   * 校验下载数据的文件头魔数 (Magic Bytes)
   */
  private validateImageMagicBytes(buf: Buffer): boolean {
    if (buf.length < 8) return false;
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
    // GIF: 47 49 46
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    // WebP: RIFF....WEBP
    if (
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
      return true;
    }
    return false;
  }

  /**
   * 带防盗链 Referer 下载原图，支持多页、临时文件与魔数校验原子落盘
   */
  public async downloadOriginalImage(pid: string, originalUrl: string, page = 0): Promise<string> {
    const ext = originalUrl.endsWith('.png') ? '.png' : '.jpg';
    const finalNameJpg = `pixiv_${pid}_p${page}.jpg`;
    const finalNamePng = `pixiv_${pid}_p${page}.png`;
    const destPathJpg = join(this.mediaDir, finalNameJpg);
    const destPathPng = join(this.mediaDir, finalNamePng);

    // 兼顾历史版本命名 pixiv_{pid}.jpg
    const legacyJpg = join(this.mediaDir, `pixiv_${pid}.jpg`);
    const legacyPng = join(this.mediaDir, `pixiv_${pid}.png`);

    if (existsSync(destPathJpg)) return destPathJpg;
    if (existsSync(destPathPng)) return destPathPng;
    if (page === 0 && existsSync(legacyJpg)) return legacyJpg;
    if (page === 0 && existsSync(legacyPng)) return legacyPng;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs * 2);

    const tmpPath = join(this.mediaDir, `pixiv_${pid}_p${page}.${Date.now()}.tmp`);

    try {
      let actualExt = ext;
      let resp = await fetch(originalUrl, {
        headers: {
          'User-Agent': PIXIV_USER_AGENT,
          'Referer': 'https://www.pixiv.net/',
        },
        signal: controller.signal,
      });

      if (resp.status === 404) {
        const altUrl = originalUrl.endsWith('.png')
          ? originalUrl.replace(/\.png$/, '.jpg')
          : originalUrl.replace(/\.jpg$/, '.png');
        actualExt = altUrl.endsWith('.png') ? '.png' : '.jpg';
        resp = await fetch(altUrl, {
          headers: {
            'User-Agent': PIXIV_USER_AGENT,
            'Referer': 'https://www.pixiv.net/',
          },
          signal: controller.signal,
        });
      }

      if (!resp.ok) {
        throw new Error(`Download failed with status ${resp.status}`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());

      // 完整性校验：文件魔数检测
      if (!this.validateImageMagicBytes(buffer)) {
        throw new Error('Downloaded file failed magic byte validation (corrupted image)');
      }

      writeFileSync(tmpPath, buffer);
      const finalPath = join(this.mediaDir, `pixiv_${pid}_p${page}${actualExt}`);
      renameSync(tmpPath, finalPath);
      return finalPath;
    } catch (err) {
      if (existsSync(tmpPath)) {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}


const FLAT_RE = /贫乳|貧乳|平胸|贫胸|微乳|小胸|飞机场/;
const BIG_RE = /巨乳|爆乳|大胸|大奶/;
/** 用户明说的体型优先：贫乳请求里去掉巨乳类标签，反之亦然，并确保核心体型标签在场 */
export function enforceBodyTags(rawText: string, tags: string[]): string[] {
  let out = [...tags];
  if (FLAT_RE.test(rawText) && !BIG_RE.test(rawText)) {
    out = out.filter(t => !/巨乳|爆乳|おっぱい|微乳/.test(t));
    if (!out.includes('貧乳')) out.unshift('貧乳');
  } else if (BIG_RE.test(rawText) && !FLAT_RE.test(rawText)) {
    out = out.filter(t => !/貧乳|微乳|ちっぱい/.test(t));
    if (!out.some(t => /巨乳|爆乳/.test(t))) out.unshift('巨乳');
  }
  return Array.from(new Set(out));
}
/** 受保护标签：放宽搜索时不得静默丢弃 */
export const PROTECTED_TAG_RE = /乳|胸|お姉さん|ロリ|髪|耳|タイツ|ストッキング|メイド|水着|制服|眼鏡|ツインテール|ポニーテール|美少女|男の娘|巫女/;

/** 全局单例服务 */

/** QQ 被动回复：同一条用户消息最多回 5 条，所以 /pixiv 单次最多 5 张（每张图 = 1 条消息，画师写在图片说明里） */
export const PIXIV_MAX_IMAGES = 5;
const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNumber(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGIT[m[1]]! : 1) * 10 + (m[2] ? CN_DIGIT[m[2]]! : 0);
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s]!;
  return NaN;
}
const NUM = '(\\d{1,4}|零|[一二两俩三四五六七八九]?十[一二三四五六七八九]?|[一二两俩三四五六七八九])';
const COUNT_RE = new RegExp(`(^|[^第\\dA-Za-z])${NUM}\\s*(张|幅|份|[pP](?![A-Za-z]))`);
const FILLER_TOKENS = new Set(['来', '来点', '来一点', '要', '给', '给我', '帮我', '请', '麻烦', '再', '再来', '就行', '就好', '即可', '谢谢', '一下', '的', '图', '图片', '插画', '美图', '吧', '呗', '啊', '呀', '哦', '嘛', '去', '爬', '去爬', '整', '搞', '发', '有没有', '那种']);
const PREFIX_RE = /^(请|麻烦)?(帮我|给我|帮忙|我要|我想要|我想看|想要|想看|去爬|去找|去搜|爬|找找|找点|找|搜索|搜一下|搜下|一下|发点|发|整点|整张|整个|整|给爷|有没有|我要看|来张|来个|搜|看看|再来|再给)+/;
const LAI_RE = /^来(点|一点|个|几张)/;
const SUFFIX_RE = /(的)?(图片|插画|美图|萌图|帅图|图)?(就行|就好|即可|谢谢|吧|呗|啊|呀|哦|嘛|那种|有没有)+$|(的)?(图片|插画|美图|萌图|帅图|图)(来)?$|的?那种$/;

/**
 * 解析自然语言 /pixiv 请求：返回关键词与数量（显式 N 张/幅/p/份；或末尾单独的 1~9 数字）。
 * 名字/标签内的数字（2B、22/7、86、5等分、初音未来 39）不会被当成数量。
 */
export function parseNaturalPixivQuery(input: string): { keyword: string; count?: number } {
  let count: number | undefined;
  let text = ` ${input.trim().replace(/[，,、。！!？?；;～~]+/g, ' ')} `;
  const m = text.match(COUNT_RE);
  if (m) {
    const v = cnToNumber(m[2]!);
    if (!Number.isNaN(v) && v > 0) count = Math.min(PIXIV_MAX_IMAGES, v);
    text = text.slice(0, m.index! + m[1]!.length) + ' ' + text.slice(m.index! + m[0].length);
  }
  const out: string[] = [];
  for (let tok of text.split(/\s+/).filter(Boolean)) {
    let prev = '';
    while (prev !== tok) {
      prev = tok;
      if (FILLER_TOKENS.has(tok)) { tok = ''; break; }
      tok = tok.replace(PREFIX_RE, '').replace(LAI_RE, '').replace(SUFFIX_RE, '');
    }
    // 粘连在词尾的常用独立标签拆开：初音未来壁纸 -> 初音未来 壁纸；2B的R-18 -> 2B R-18
    const tail: string[] = [];
    let mm: RegExpMatchArray | null;
    while (tok && (mm = tok.match(/^(.+?)的?(壁纸|R-18G?|r18g?|R18G?)$/))) { tail.unshift(mm[2]!); tok = mm[1]!; }
    if (tok) out.push(tok);
    out.push(...tail);
  }
  // 末尾单独数字 1~9 视为数量（如 "/pixiv 信浓 3"），更大的数字保留为标签
  if (count === undefined && out.length > 1 && /^[1-9]$/.test(out[out.length - 1]!)) {
    count = Math.min(PIXIV_MAX_IMAGES, parseInt(out.pop()!, 10));
  }
  return { keyword: out.join(' '), count };
}

export const defaultPixivService = new PixivService();
