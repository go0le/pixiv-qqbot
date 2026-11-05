/**
 * 把 Pixiv 网页 AJAX 与 app-api 的搜索条目收成同一种结构。
 * 标签可能是字符串，也可能是 { name / tag } 对象；不归一化的话后续 AND 会直接抛错或静默失配。
 */

export interface MappedSearchWork {
  pid: string;
  title: string;
  artist: string;
  tags: string[];
  bookmarks: number;
  /** 接口是否真的给了收藏数（app-api 有 total_bookmarks；网页搜索结果没有） */
  bookmarksKnown: boolean;
  uploadDate: string;
  originalUrl?: string;
  illustType: number;
  xRestrict: number;
  aiType: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function coerceTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) tags.push(trimmed);
      continue;
    }
    if (!isRecord(item)) continue;
    const named = item.name ?? item.tag ?? item.translated_name;
    if (typeof named === 'string' && named.trim()) tags.push(named.trim());
  }
  return tags;
}

/** 只认 xRestrict / x_restrict。app-api 的 restrict 是公开/私密，不是分级。 */
export function readXRestrict(item: Record<string, unknown>, assumeMissingIsR18: boolean): number {
  const raw = item.xRestrict ?? item.x_restrict;
  if (raw === undefined || raw === null || raw === '') {
    return assumeMissingIsR18 ? 1 : 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return assumeMissingIsR18 ? 1 : 0;
  return n;
}

export function readIllustType(item: Record<string, unknown>): number {
  const raw = item.illustType ?? item.type;
  if (raw === 'ugoira' || raw === 2 || raw === '2') return 2;
  if (raw === 'manga' || raw === 1 || raw === '1') return 1;
  if (raw === 'illust' || raw === 0 || raw === '0' || raw == null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function readAiType(item: Record<string, unknown>): number {
  const raw = item.aiType ?? item.illust_ai_type ?? item.ai_type ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function rewritePixivImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.includes('/c/')) return url;
  return url
    .replace(/https:\/\/[^/]+\/c\/[^/]+\/(img-master|custom-thumb)\//, 'https://i.pximg.net/img-original/')
    .replace(/_(square|custom|master)\d*\./, '.');
}

export function pickOriginalUrl(item: Record<string, unknown>): string | undefined {
  const single = isRecord(item.meta_single_page) ? item.meta_single_page : undefined;
  if (typeof single?.original_image_url === 'string') return single.original_image_url;

  if (Array.isArray(item.meta_pages) && isRecord(item.meta_pages[0])) {
    const urls = isRecord(item.meta_pages[0].image_urls) ? item.meta_pages[0].image_urls : undefined;
    if (typeof urls?.original === 'string') return urls.original;
    if (typeof urls?.large === 'string') return rewritePixivImageUrl(urls.large);
  }

  const imageUrls = isRecord(item.image_urls) ? item.image_urls : undefined;
  if (typeof imageUrls?.large === 'string') return rewritePixivImageUrl(imageUrls.large);
  if (typeof item.url === 'string') return rewritePixivImageUrl(item.url);
  return undefined;
}

export function extractSearchWorks(json: unknown): Record<string, unknown>[] {
  if (!isRecord(json)) return [];
  if (Array.isArray(json.illusts)) return json.illusts.filter(isRecord);
  if (!isRecord(json.body)) return [];
  for (const bucket of [json.body.illust, json.body.illustManga]) {
    if (isRecord(bucket) && Array.isArray(bucket.data)) return bucket.data.filter(isRecord);
  }
  return [];
}

function readArtist(item: Record<string, unknown>): string {
  if (typeof item.userName === 'string' && item.userName.trim()) return item.userName.trim();
  if (isRecord(item.user) && typeof item.user.name === 'string' && item.user.name.trim()) {
    return item.user.name.trim();
  }
  if (isRecord(item.authorDetails) && typeof item.authorDetails.name === 'string' && item.authorDetails.name.trim()) {
    return item.authorDetails.name.trim();
  }
  return '未知画师';
}

export function mapSearchWork(
  item: Record<string, unknown>,
  assumeMissingIsR18: boolean,
): MappedSearchWork | null {
  const id = item.id ?? item.illust_id;
  if (id === undefined || id === null || id === '') return null;
  const illustType = readIllustType(item);
  if (illustType === 2) return null;
  const uploadRaw = item.createDate ?? item.create_date ?? item.updateDate ?? item.update_date;
  const bookmarksField = item.bookmarkCount ?? item.total_bookmarks;
  const bookmarksRaw = Number(bookmarksField ?? item.likeCount ?? 0);
  const titleRaw = item.title ?? item.illustTitle;
  return {
    pid: String(id),
    title: typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw : '无标题',
    artist: readArtist(item),
    tags: coerceTags(item.tags),
    bookmarks: Number.isFinite(bookmarksRaw) ? bookmarksRaw : 0,
    bookmarksKnown: bookmarksField !== undefined && bookmarksField !== null && Number.isFinite(Number(bookmarksField)),
    uploadDate: typeof uploadRaw === 'string' && uploadRaw ? uploadRaw : new Date().toISOString(),
    originalUrl: pickOriginalUrl(item),
    illustType,
    xRestrict: readXRestrict(item, assumeMissingIsR18),
    aiType: readAiType(item),
  };
}

export function buildIllustrationSearchUrl(
  queryTag: string,
  opts: { wantsR18: boolean; appApi: boolean; proxyBaseUrl?: string; page?: number },
): string {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  if (opts.appApi) {
    const params = new URLSearchParams({
      word: queryTag,
      search_target: queryTag.includes(' ') ? 'partial_match_for_tags' : 'exact_match_for_tags',
      sort: 'date_desc',
    });
    // app-api 每页 30 条，第 N 页用 offset 翻
    if (page > 1) params.set('offset', String((page - 1) * 30));
    // for_ios 会把 R-18 从 app-api 结果里拿掉。明文要 R-18 时不能带这个滤镜。
    // for_ios 会同时滤掉 Pixiv 标记为“敏感”的全年龄图，结果过于“健全”。默认不再加；
    // 官方 R-18 仍由 checkImageGreylist(xRestrict>0) 在本地拦截。PIXIV_SAFE_FILTER=1 恢复旧行为。
    if (!opts.wantsR18 && process.env.PIXIV_SAFE_FILTER === '1') params.set('filter', 'for_ios');
    return `https://app-api.pixiv.net/v1/search/illust?${params.toString()}`;
  }

  const sMode = queryTag.includes(' ') ? 's_tag' : 's_tag_full';
  // 默认 safe，避免 mode=all 的第一页几乎全是全年龄图，把明文 R-18 请求“搜丢”。
  const mode = opts.wantsR18 ? 'r18' : 'safe';
  const origin = (opts.proxyBaseUrl || 'https://www.pixiv.net').replace(/\/$/, '');
  const q = encodeURIComponent(queryTag);
  return `${origin}/ajax/search/illustrations/${q}?word=${q}&order=date_d&mode=${mode}&p=${page}&s_mode=${sMode}&type=illust`;
}
