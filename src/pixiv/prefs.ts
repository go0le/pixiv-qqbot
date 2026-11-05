/**
 * 搜图偏好（按会话）：用户对发出去的图给的反馈——喜欢 / 不喜欢 / 拉黑画师。
 *
 * - 会话键和已发历史一致（c2c:<QQ号> / group:<群号>），所以私聊是个人偏好，群里是全群共用的偏好；
 * - 只有 QQ 机器人进程写这个文件；各个 pixiv MCP 进程（管理员、访客）只读，按 mtime 自动重新加载，
 *   这样不管走软路由还是让 Agent 调工具，同一个会话用的是同一份偏好；
 * - 偏好只影响「在已经合规的候选里怎么排」和「哪些画师/作品不再发」，绝不放宽任何黑/灰名单；
 * - 灰名单（R-18 等）标签不学习，偏好文件里不出现这类词。
 *
 * 文件路径：PIXIV_PREFS_FILE，未设置时由调用方给默认值。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractRequestedGreylist } from './filter.ts';

export interface ChatPixivPrefs {
  /** Pixiv 标签 → 权重（正 = 喜欢，负 = 不喜欢），夹在 ±WEIGHT_CAP */
  tags: Record<string, number>;
  /** 画师名 → 权重 */
  artists: Record<string, number>;
  /** 不再发的画师 */
  blockedArtists: string[];
  /** 明确说过不喜欢的作品，历史重置后也不再发 */
  blockedPids: string[];
  likes: number;
  dislikes: number;
  updatedAt: number;
}

/** 用来学习偏好的作品信息 */
export interface PrefsWork {
  pid: string;
  artist: string;
  tags: string[];
}

/** 可以按偏好调整的候选（PixivIllustration 满足这个形状） */
export interface PrefsCandidate {
  pid: string;
  artist: string;
  tags: string[];
  score: number;
}

export type FeedbackKind = 'like' | 'dislike';

const WEIGHT_CAP = 5;
const MAX_TAGS = 300;
const MAX_ARTISTS = 200;
const MAX_BLOCKED_ARTISTS = 100;
const MAX_BLOCKED_PIDS = 500;
const MAX_CHATS = 5000;
/** 每次反馈最多学作品的前几个标签（Pixiv 标签按作者填写顺序，前面的更核心） */
const LEARN_TAGS = 12;
/** 不学习的通用标签：几乎每张图都有，学了只会放大噪声 */
const IGNORED_TAG_RE = /users入り$|^(女の子|女孩子|オリジナル|創作|イラスト|落書き|らくがき|少女|美少女|漫画|マンガ|manga|illustration|original|girl|pixiv|ファンアート|fanart)$/i;
const CHAT_KEY_RE = /^[A-Za-z0-9_:-]{1,80}$/;

/** 文件路径：PIXIV_PREFS_FILE 优先，否则用调用方给的默认值 */
export function resolvePrefsFile(defaultFile: string): string {
  const env = process.env.PIXIV_PREFS_FILE;
  return env ? resolve(env) : defaultFile;
}

function clampWeight(n: number): number {
  return Math.max(-WEIGHT_CAP, Math.min(WEIGHT_CAP, Math.round(n * 100) / 100));
}

/** 这个标签能不能用来学偏好：去掉通用词、灰名单词和过长的标签 */
export function isLearnableTag(tag: string): boolean {
  const t = tag.trim();
  if (!t || t.length > 40 || IGNORED_TAG_RE.test(t)) return false;
  return extractRequestedGreylist([t]).size === 0;
}

function emptyPrefs(): ChatPixivPrefs {
  return { tags: {}, artists: {}, blockedArtists: [], blockedPids: [], likes: 0, dislikes: 0, updatedAt: Date.now() };
}

function sanitize(raw: unknown): ChatPixivPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ChatPixivPrefs>;
  const weights = (o: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        const n = Number(v);
        if (k && Number.isFinite(n) && n !== 0) out[k] = clampWeight(n);
      }
    }
    return out;
  };
  const strings = (a: unknown, max: number): string[] =>
    Array.isArray(a) ? Array.from(new Set(a.filter((x): x is string => typeof x === 'string' && !!x.trim()))).slice(-max) : [];
  return {
    tags: weights(r.tags),
    artists: weights(r.artists),
    blockedArtists: strings(r.blockedArtists, MAX_BLOCKED_ARTISTS),
    blockedPids: strings(r.blockedPids, MAX_BLOCKED_PIDS).filter(p => /^\d{1,12}$/.test(p)),
    likes: Math.max(0, Number(r.likes) || 0),
    dislikes: Math.max(0, Number(r.dislikes) || 0),
    updatedAt: Number(r.updatedAt) || 0,
  };
}

/** 权重表只留绝对值最大的 max 项 */
function trimWeights(w: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(w).filter(([, v]) => v !== 0);
  if (entries.length <= max) return Object.fromEntries(entries);
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Object.fromEntries(entries.slice(0, max));
}

/** 去掉「(作品名)」后缀并转小写，用于判断候选标签是不是本次搜索词本身 */
function coreOf(tag: string): string {
  return tag.replace(/[(（][^()（）]*[)）]$/, '').trim().toLowerCase();
}

export class PixivPrefsStore {
  private data: Record<string, ChatPixivPrefs> = {};
  private mtimeMs = -1;

  /** file 为 null 时只在内存里（测试用） */
  public constructor(private readonly file: string | null) {
    this.reload(true);
  }

  public get path(): string | null {
    return this.file;
  }

  /** 文件被其它进程改了（按 mtime）就重新读；读坏了沿用内存里的上一份 */
  private reload(force = false): void {
    if (!this.file) return;
    try {
      if (!existsSync(this.file)) {
        if (force || this.mtimeMs !== -1) { this.data = {}; this.mtimeMs = -1; }
        return;
      }
      const m = statSync(this.file).mtimeMs;
      if (!force && m === this.mtimeMs) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { chats?: Record<string, unknown> };
      const next: Record<string, ChatPixivPrefs> = {};
      for (const [k, v] of Object.entries(raw?.chats ?? {})) {
        if (!CHAT_KEY_RE.test(k)) continue;
        const p = sanitize(v);
        if (p) next[k] = p;
      }
      this.data = next;
      this.mtimeMs = m;
    } catch (err) {
      console.error('[PixivPrefs] 偏好文件读取失败，沿用上一份:', err instanceof Error ? err.message : err);
    }
  }

  private save(): void {
    if (!this.file) return;
    const keys = Object.keys(this.data);
    if (keys.length > MAX_CHATS) {
      keys.sort((a, b) => (this.data[a]!.updatedAt - this.data[b]!.updatedAt));
      for (const k of keys.slice(0, keys.length - MAX_CHATS)) delete this.data[k];
    }
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, chats: this.data }, null, 1), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    try { this.mtimeMs = statSync(this.file).mtimeMs; } catch { /* ignore */ }
  }

  private mutate(chatKey: string, fn: (p: ChatPixivPrefs) => boolean): boolean {
    if (!CHAT_KEY_RE.test(chatKey)) return false;
    this.reload();
    const p = this.data[chatKey] ?? emptyPrefs();
    if (!fn(p)) return false;
    p.updatedAt = Date.now();
    p.tags = trimWeights(p.tags, MAX_TAGS);
    p.artists = trimWeights(p.artists, MAX_ARTISTS);
    this.data[chatKey] = p;
    this.save();
    return true;
  }

  public get(chatKey: string): ChatPixivPrefs | undefined {
    this.reload();
    return this.data[chatKey];
  }

  /** 记一次反馈：喜欢 → 画师 +1、标签 +0.5；不喜欢 → 画师 −1、标签 −0.5，并且这张作品以后不再发 */
  public feedback(chatKey: string, work: PrefsWork, kind: FeedbackKind): boolean {
    return this.mutate(chatKey, p => {
      const sign = kind === 'like' ? 1 : -1;
      const artist = work.artist?.trim();
      if (artist && artist !== '未知画师' && artist !== '未知') {
        p.artists[artist] = clampWeight((p.artists[artist] ?? 0) + sign);
        if (p.artists[artist] === 0) delete p.artists[artist];
      }
      for (const tag of (work.tags ?? []).filter(isLearnableTag).slice(0, LEARN_TAGS)) {
        p.tags[tag] = clampWeight((p.tags[tag] ?? 0) + sign * 0.5);
        if (p.tags[tag] === 0) delete p.tags[tag];
      }
      if (kind === 'like') {
        p.likes += 1;
        p.blockedPids = p.blockedPids.filter(x => x !== work.pid);
      } else {
        p.dislikes += 1;
        if (/^\d{1,12}$/.test(work.pid) && !p.blockedPids.includes(work.pid)) {
          p.blockedPids.push(work.pid);
          if (p.blockedPids.length > MAX_BLOCKED_PIDS) p.blockedPids.splice(0, p.blockedPids.length - MAX_BLOCKED_PIDS);
        }
      }
      return true;
    });
  }

  /** 拉黑画师。已经拉黑过返回 false */
  public blockArtist(chatKey: string, artist: string): boolean {
    const a = artist.trim();
    if (!a || a === '未知画师' || a.length > 100) return false;
    return this.mutate(chatKey, p => {
      if (p.blockedArtists.includes(a)) return false;
      p.blockedArtists.push(a);
      if (p.blockedArtists.length > MAX_BLOCKED_ARTISTS) p.blockedArtists.splice(0, p.blockedArtists.length - MAX_BLOCKED_ARTISTS);
      delete p.artists[a];
      return true;
    });
  }

  public unblockArtist(chatKey: string, artist: string): boolean {
    const a = artist.trim();
    return this.mutate(chatKey, p => {
      const i = p.blockedArtists.indexOf(a);
      if (i < 0) return false;
      p.blockedArtists.splice(i, 1);
      return true;
    });
  }

  /** 清空这个会话的全部偏好。本来就没有返回 false */
  public reset(chatKey: string): boolean {
    this.reload();
    if (!this.data[chatKey]) return false;
    delete this.data[chatKey];
    this.save();
    return true;
  }

  /** 这个候选在本会话被拉黑了（画师或作品） */
  public isBlocked(p: ChatPixivPrefs | undefined, item: { pid: string; artist: string }): boolean {
    if (!p) return false;
    return p.blockedPids.includes(item.pid) || p.blockedArtists.includes(item.artist);
  }

  /**
   * 偏好系数，乘在综合分上：exp(0.25 × 画师权重 + 0.08 × 命中标签权重之和)，夹在 [0.4, 2.5]。
   * 本次搜索词本身（所有候选都有）不参与计算，只看能区分候选的标签；每个候选最多算 8 个权重最大的标签。
   */
  public factor(p: ChatPixivPrefs | undefined, item: { artist: string; tags: string[] }, queryTags: string[] = []): number {
    if (!p) return 1;
    const query = queryTags.map(coreOf).filter(Boolean);
    const isQuery = (t: string): boolean => {
      const c = coreOf(t);
      return query.some(q => c === q || (q.length >= 2 && c.includes(q)) || (c.length >= 2 && q.includes(c)));
    };
    const tagWeights = (item.tags ?? [])
      .filter(t => p.tags[t] !== undefined && !isQuery(t))
      .map(t => p.tags[t]!)
      .sort((a, b) => Math.abs(b) - Math.abs(a))
      .slice(0, 8);
    const s = 0.25 * (p.artists[item.artist] ?? 0) + 0.08 * tagWeights.reduce((n, w) => n + w, 0);
    return Math.max(0.4, Math.min(2.5, Math.exp(s)));
  }

  /**
   * 按偏好处理一批候选：去掉拉黑的画师/作品，其余综合分乘上偏好系数（返回新对象，不改原对象）。
   * 这个会话没有偏好时原样返回。
   */
  public apply<T extends PrefsCandidate>(chatKey: string, list: T[], queryTags: string[] = []): T[] {
    const p = this.get(chatKey);
    if (!p) return list;
    const out: T[] = [];
    for (const it of list) {
      if (this.isBlocked(p, it)) continue;
      const f = this.factor(p, it, queryTags);
      out.push(f === 1 ? it : { ...it, score: it.score * f });
    }
    return out;
  }

  /** 给人看的摘要：偏爱/不喜欢的画师和标签各取前几个 */
  public summary(chatKey: string, top = 5): {
    likes: number; dislikes: number;
    likedArtists: string[]; dislikedArtists: string[]; likedTags: string[]; dislikedTags: string[];
    blockedArtists: string[]; blockedPids: number;
  } | null {
    const p = this.get(chatKey);
    if (!p) return null;
    const pick = (w: Record<string, number>, positive: boolean): string[] => Object.entries(w)
      .filter(([, v]) => (positive ? v > 0 : v < 0))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, top)
      .map(([k]) => k);
    return {
      likes: p.likes,
      dislikes: p.dislikes,
      likedArtists: pick(p.artists, true),
      dislikedArtists: pick(p.artists, false),
      likedTags: pick(p.tags, true),
      dislikedTags: pick(p.tags, false),
      blockedArtists: [...p.blockedArtists],
      blockedPids: p.blockedPids.length,
    };
  }
}
