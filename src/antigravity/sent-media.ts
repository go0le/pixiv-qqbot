/**
 * 记住哈Gemi 发出去的每张 Pixiv 图是什么（QQ 消息 ID → 作品信息），用来：
 * 1) 群友引用（回复）她发的图时，告诉她那张图到底是什么（作品名、画师、标签、上传时间），并把图给她看；
 * 2) 在提示词里列出她最近在这个会话里发过的几张图，聊到「刚才那张」时有据可查。
 *
 * 起因（2026-11-05 某群）：快速搜图通道发图不经过 Agent，她不知道自己发了什么；
 * 群友引用一张碧蓝航线山城的图说「将近10年前的都来了」，她顺着之前聊过的蕾姆，说成了「Re0 都快十年了」。
 *
 * 只存作品的公开元数据和本地图片路径，不存聊天内容。持久化到 ~/.dsh-qqbot/sent-media.json，条数有上限。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface SentImageInfo {
  chatKey: string;
  at: number;
  pid: string;
  title: string;
  artist: string;
  tags: string[];
  uploadDate?: string;
  bookmarks?: number;
  localPath?: string;
}

const MAX_ENTRIES = 3000;
const DEFAULT_FILE = resolve(homedir(), '.dsh-qqbot', 'sent-media.json');

export class SentMediaLog {
  private readonly byId = new Map<string, SentImageInfo>();
  private readonly recentByChat = new Map<string, SentImageInfo[]>();
  private saveTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly file: string | null = DEFAULT_FILE) {
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: Array<[string, SentImageInfo]> };
      for (const [id, info] of d.entries ?? []) if (id && info?.pid) this.add(id, info);
    } catch { /* 损坏则从空开始 */ }
  }

  private add(id: string, info: SentImageInfo): void {
    this.byId.set(id, info);
    while (this.byId.size > MAX_ENTRIES) this.byId.delete(this.byId.keys().next().value!);
    const arr = this.recentByChat.get(info.chatKey) ?? [];
    arr.push(info);
    while (arr.length > 10) arr.shift();
    this.recentByChat.set(info.chatKey, arr);
  }

  /** 记一张发出去的图。messageId 拿不到时只进「最近发过的图」，不能按引用查 */
  public note(messageId: string | number | undefined, info: Omit<SentImageInfo, 'at'>): void {
    const full: SentImageInfo = { ...info, at: Date.now() };
    if (messageId !== undefined && messageId !== null && String(messageId)) {
      this.add(String(messageId), full);
      this.saveSoon();
    } else {
      const arr = this.recentByChat.get(info.chatKey) ?? [];
      arr.push(full);
      while (arr.length > 10) arr.shift();
      this.recentByChat.set(info.chatKey, arr);
    }
  }

  public byMessageId(id: string | number | undefined): SentImageInfo | undefined {
    if (id === undefined || id === null) return undefined;
    return this.byId.get(String(id));
  }

  /** 这个会话最近发过的图（新的在后），默认 30 分钟内最多 3 张 */
  public recent(chatKey: string, limit = 3, maxAgeMs = 30 * 60_000): SentImageInfo[] {
    const cutoff = Date.now() - maxAgeMs;
    return (this.recentByChat.get(chatKey) ?? []).filter(i => i.at >= cutoff).slice(-limit);
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 3_000);
    this.saveTimer.unref?.();
  }

  public flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.file) return;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries: [...this.byId.entries()] }), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.file);
    } catch { /* ignore */ }
  }
}

/** 一张图的简短中文描述：《标题》· 画师 · 标签 · 上传日期 · 收藏数 */
export function describeSentImage(i: SentImageInfo, maxTags = 6): string {
  const tags = i.tags.filter(t => !/users入り$/.test(t)).slice(0, maxTags).join('、');
  const date = i.uploadDate ? String(i.uploadDate).slice(0, 10) : '';
  return [
    `《${i.title}》`,
    `画师 ${i.artist}`,
    tags ? `标签 ${tags}` : '',
    date ? `${date} 上传` : '',
    typeof i.bookmarks === 'number' && i.bookmarks > 0 ? `${i.bookmarks} 收藏` : '',
  ].filter(Boolean).join(' · ');
}

interface MetaRow { pid?: string; title?: string; artist?: string; tags?: string[]; uploadDate?: string; bookmarks?: number; filePath?: string }
const metaCache = new Map<string, { mtimeMs: number; rows: Map<string, MetaRow> }>();

function rowsOf(file: string): Map<string, MetaRow> {
  try {
    if (!existsSync(file)) return new Map();
    const mtimeMs = statSync(file).mtimeMs;
    const hit = metaCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.rows;
    const list = JSON.parse(readFileSync(file, 'utf8')) as MetaRow[];
    const rows = new Map<string, MetaRow>();
    if (Array.isArray(list)) for (const r of list) if (r?.pid) rows.set(String(r.pid), r);
    metaCache.set(file, { mtimeMs, rows });
    return rows;
  } catch {
    return new Map();
  }
}

/** 按 PID 在各个 pixiv 元数据文件里查作品信息（机器人自己的、管理员 MCP 的、访客 MCP 的） */
export function lookupPixivMeta(pid: string, extraMetadataFiles: string[] = []): MetaRow | undefined {
  const files = [
    resolve(homedir(), '.dsh-qqbot', 'pixiv_metadata.json'),
    resolve(process.env.PIXIV_MCP_HOME ? resolve(process.env.PIXIV_MCP_HOME) : resolve(homedir(), '.pixiv-mcp'), 'pixiv_metadata.json'),
    ...extraMetadataFiles,
  ];
  for (const f of files) {
    const r = rowsOf(f).get(pid);
    if (r) return r;
  }
  return undefined;
}
