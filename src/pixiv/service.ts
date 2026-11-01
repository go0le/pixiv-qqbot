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
import {
  CHARACTER_TAG_MAP,
  COMMON_ATTR_MAP,
  GREYLIST_CATEGORIES,
  QUALITY_WATERFALL_TIERS,
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

/** 富媒体缓存目录 */
export const PIXIV_MEDIA_DIR = resolve(homedir(), '.dsh-qqbot', 'media');
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
}

export class PixivService {
  private readonly mediaDir: string;
  private readonly metadataFile: string;
  private readonly metadataBackupFile: string;
  private readonly dynamicTagStore: DynamicTagStore;
  private readonly llmTagResolver: LlmTagResolver;
  private readonly history: PixivHistoryManager;
  private readonly limiter: PixivRateLimiter;
  private readonly timeoutMs: number;
  private readonly chatMutex = new KeyedMutex();
  private readonly pixivAuth = new PixivAuth();
  private readonly cleanupFn: () => void;

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
    this.history = config.historyManager || defaultPixivHistory;
    this.limiter = config.rateLimiter || defaultPixivLimiter;
    this.timeoutMs = config.timeoutMs ?? 15000;
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
      for (const f of files) {
        if (f.endsWith('.tmp')) {
          try { unlinkSync(join(this.mediaDir, f)); } catch { /* ignore */ }
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
    const prefixes = ['碧蓝航线', '碧蓝', '舰b', '原神', '星穹铁道', '星铁', '崩铁', '蔚蓝档案', 'ba', '明日方舟', '方舟'];
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
      const dyn = this.dynamicTagStore?.get(token);
      if (dyn && dyn.length > 0) return dyn.join(' ');
      return this.resolveSingleTag(token);
    });
  }

  /**
   * 异步智能解析标签列表：静态规则 + 动态自学习表 + LLM 语义回填持久化
   */
  public async resolveTagListAsync(input: string | string[]): Promise<string[]> {
    const rawTokens = (Array.isArray(input) ? input : [input])
      .flatMap(i => i.trim().split(/\s+/))
      .filter(Boolean);

    if (rawTokens.length === 0) return [];

    const resolved: string[] = [];
    const unmappedIndices: number[] = [];
    const unmappedTokens: string[] = [];

    for (let i = 0; i < rawTokens.length; i++) {
      const token = rawTokens[i]!;

      // 1. 优先查动态自学习映射表
      const dynamicMatch = this.dynamicTagStore?.get(token);
      if (dynamicMatch && dynamicMatch.length > 0) {
        resolved.push(...dynamicMatch);
        continue;
      }

      // 2. 查静态规则字典与消歧表
      const staticMatch = this.resolveSingleTag(token);
      if (staticMatch !== token) {
        resolved.push(staticMatch);
        continue;
      }

      // 3. 检查是否为包含中文自然语言描述的未收录词语/短语
      const hasChinese = /[\u4e00-\u9fa5]/.test(token);
      if (hasChinese) {
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
      return Array.from(new Set(resolved.filter(Boolean)));
    }

    // 调用 LLM 进行语义理解与 Pixiv 规范标签对齐
    const fullInput = rawTokens.join(' ');
    const llmResult = await this.llmTagResolver.resolve(unmappedTokens, fullInput);

    if (llmResult && llmResult.tags.length > 0) {
      // 将大模型提炼的学习映射批量回填入动态自学习表，并持久化到本地磁盘
      if (llmResult.mappings && Object.keys(llmResult.mappings).length > 0) {
        this.dynamicTagStore.setBatch(llmResult.mappings);
        this.dynamicTagStore.save();
      }

      // 组装最终结果
      const finalTags: string[] = [];
      let unmappedCursor = 0;

      for (let i = 0; i < resolved.length; i++) {
        if (unmappedIndices.includes(i)) {
          const originalToken = unmappedTokens[unmappedCursor++];
          const mapped = (originalToken && llmResult.mappings[originalToken])
            || (originalToken && this.dynamicTagStore.get(originalToken));

          if (mapped && mapped.length > 0) {
            finalTags.push(...mapped);
          } else {
            finalTags.push(...llmResult.tags);
          }
        } else {
          finalTags.push(resolved[i]!);
        }
      }

      return Array.from(new Set(finalTags.filter(Boolean)));
    }

    // LLM 不可用或解析失败时的优雅降级：保留原分词
    return Array.from(new Set(resolved.filter(Boolean)));
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
      return this.doSearchIllustrations(chatKey, keyword, count);
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

    const targetCount = Math.max(1, Math.min(3, count)); // 单次上限收紧为 3 张
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
        };
        allLocalForTag.push(illust);
        if (!sentPids.has(meta.pid)) {
          localMatches.push(illust);
        }
      }
    }

    localMatches.sort((a, b) => b.score - a.score);

    // 本地未看过充足，直接抽选返回
    if (localMatches.length >= targetCount) {
      const selected = this.sampleTopK(localMatches, targetCount);
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
        fetchedIllusts = await this.fetchFromNetwork(tag, allowedGreylist, resolvedTags, tokens);
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

    let candidateList = Array.from(candidatesMap.values());
    candidateList.sort((a, b) => b.score - a.score);

    // 4. 耗尽兜底（防循环刷屏：需校验 120 秒冷却）
    if (candidateList.length === 0) {
      if (this.history.canReset(chatKey)) {
        this.history.clearChat(chatKey);
        exhaustedReset = true;

        for (const item of allLocalForTag) {
          candidatesMap.set(item.pid, item);
        }
        for (const item of fetchedIllusts) {
          candidatesMap.set(item.pid, item);
        }
        candidateList = Array.from(candidatesMap.values());
        candidateList.sort((a, b) => b.score - a.score);
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

    // 5. 采样指定数量
    const chosen = this.sampleTopK(candidateList, targetCount);

    // 6. 缓存入库门禁：确保选中的图片原图已下载，并通过完整性校验与质检网落盘
    const finalized: PixivIllustration[] = [];
    let updatedLocalCache = false;
    for (const item of chosen) {
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

          const downloadedPath = await this.downloadOriginalImage(
            item.pid,
            item.originalUrl,
            item.page ?? 0,
          );
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
  ): Promise<PixivIllustration[]> {
    const wantsR18 = allowedGreylist.has('r18');
    const searchUrl = buildIllustrationSearchUrl(queryTag, {
      wantsR18,
      appApi: auth.appApi,
      proxyBaseUrl: auth.proxyBaseUrl,
    });
    const json = await this.fetchJson(searchUrl, auth.headers);
    const rows = extractSearchWorks(json);
    // 只有网页 mode=r18 能在字段缺失时视为官方 R-18。app-api 不带 for_ios 时安全图和 R-18 混在一起，缺字段不能猜。
    const assumeMissingIsR18 = wantsR18 && !auth.appApi;

    const results: PixivIllustration[] = [];
    for (const row of rows) {
      const mapped = mapSearchWork(row, assumeMissingIsR18);
      if (!mapped) continue;

      const effectiveBookmarks = Math.max(mapped.bookmarks, minScoreBias);
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
      });
    }
    return results;
  }

  /**
   * 质量阶梯漏斗：10000 → 5000 → 1000 → 500 users入り，最后才用纯标签。
   * resolvedTags / rawTokens 传给每一档，避免网络结果绕过 AND。
   */
  private async fetchFromNetwork(
    tag: string,
    allowedGreylist: Set<string>,
    resolvedTags: string[] = [],
    rawTokens: string[] = [],
  ): Promise<PixivIllustration[]> {
    const auth = await this.buildSearchAuth();
    for (const tier of QUALITY_WATERFALL_TIERS) {
      const tierTag = `${tag} ${tier.suffix}`;
      try {
        const candidates = await this.fetchFromNetworkSingleQuery(
          tierTag,
          tag,
          tier.minScoreBias,
          allowedGreylist,
          auth,
          resolvedTags,
          rawTokens,
        );
        if (candidates.length > 0) return candidates;
      } catch {
        // 单个阶梯失败就降到下一档
      }
      await new Promise(r => setTimeout(r, 300));
    }
    return this.fetchFromNetworkSingleQuery(tag, tag, 0, allowedGreylist, auth, resolvedTags, rawTokens);
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

/** 全局单例服务 */
export const defaultPixivService = new PixivService();
