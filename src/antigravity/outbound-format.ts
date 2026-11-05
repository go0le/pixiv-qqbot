/**
 * Agent 回复的出站排版。
 *
 * 要图类回复有硬性约束：每张图只能带「🎨 画师：xxx」，不得夹带作品标题、PID、Pixiv 链接、本地路径或其它说明。
 * Agent（LLM）不一定守这条规矩，所以在适配器出口强制整形：只要回复里带了 Pixiv 图片（文件名 pixiv_<pid>_p<n>）
 * 或含画师行，就丢掉全部正文，每张图单独发一条「图片 + 画师行」，画师名优先取本地元数据，其次取回复里的画师行。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { homedir } from 'node:os';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const PIXIV_FILE_RE = /^pixiv_(\d+)(?:_p\d+)?/i;
const ARTIST_LINE_RE = /🎨\s*画师\s*[:：]\s*([^\n\r]+)/g;

/** OneBot CQ 码里「普通文本」的转义：& [ ] 会被当成 CQ 语法，画师名/关键词/模型输出都不可信 */
export function escapeCqText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

/** CQ 码参数值的转义：在文本转义之外再转义逗号 */
export function escapeCqParam(text: string): string {
  return escapeCqText(text).replace(/,/g, '&#44;');
}

export function isImageFile(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase());
}

/** 去掉「AI 助手腔」的 Markdown 痕迹：QQ 不渲染 Markdown，`###`/`**` 只会原样难看地显示。
 *  只清标题前缀和成对的粗体/强调记号，保留代码围栏与单个 `*`（可能是 *动作* 星号）。 */
export function sanitizeChatText(s: string): string {
  if (!s) return s;
  let t = s;
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');   // 去 ATX 标题的 # 前缀，保留文字
  t = t.replace(/\*\*(.+?)\*\*/gs, '$1');            // **粗体** -> 文字
  t = t.replace(/(?<![*])__(.+?)__(?![*])/gs, '$1');  // __强调__ -> 文字
  t = t.replace(/\n{3,}/g, '\n\n');                  // 收敛多余空行
  return t.trim();
}

const EXPR_RE = /\[\s*表情\s*[:：]\s*([^\]\s]{1,10})\s*\]/;
const EXPR_RE_G = /\[\s*表情\s*[:：]\s*[^\]\s]{1,10}\s*\]/g;
/** 取出回复里的 `[表情:xxx]` 情绪标记（取第一个），并把所有此类标记从正文删掉 */
export function extractExpression(raw: string): { clean: string; expression?: string } {
  const m = raw.match(EXPR_RE);
  const expression = m?.[1];
  const clean = raw.replace(EXPR_RE_G, '').replace(/\n{3,}/g, '\n\n').trim();
  return { clean, expression };
}

export function pixivPidOf(filePath: string): string | undefined {
  return basename(filePath).match(PIXIV_FILE_RE)?.[1];
}

function metadataFiles(): string[] {
  const mcpHome = process.env.PIXIV_MCP_HOME ? resolve(process.env.PIXIV_MCP_HOME) : resolve(homedir(), '.pixiv-mcp');
  return [
    resolve(homedir(), '.dsh-qqbot', 'pixiv_metadata.json'),
    resolve(mcpHome, 'pixiv_metadata.json'),
  ];
}

interface MetaCache { mtimeMs: number; artists: Map<string, string> }
const metaCache = new Map<string, MetaCache>();

function artistsOf(file: string): Map<string, string> {
  try {
    if (!existsSync(file)) return new Map();
    const mtimeMs = statSync(file).mtimeMs;
    const hit = metaCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.artists;
    const list = JSON.parse(readFileSync(file, 'utf8')) as Array<{ pid?: string; artist?: string }>;
    const artists = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const it of list) {
        if (it && it.pid && typeof it.artist === 'string' && it.artist.trim()) artists.set(String(it.pid), it.artist.trim());
      }
    }
    metaCache.set(file, { mtimeMs, artists });
    return artists;
  } catch {
    return new Map();
  }
}

/** 按文件名里的 PID 查本地元数据里的画师名 */
export function lookupPixivArtist(filePath: string): string | undefined {
  const pid = pixivPidOf(filePath);
  if (!pid) return undefined;
  for (const f of metadataFiles()) {
    const a = artistsOf(f).get(pid);
    if (a) return a;
  }
  return undefined;
}

function cleanArtist(raw: string): string {
  return raw
    .replace(/[\s*_`]+$/g, '')
    .replace(/^[\s*_`]+/g, '')
    .replace(/\s*[(（]\s*PID.*$/i, '')
    .trim();
}

export function extractArtistLines(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ARTIST_LINE_RE)) {
    const a = cleanArtist(m[1] ?? '');
    if (a) out.push(a);
  }
  return out;
}

export interface DeliveryPlan {
  /** 依次发送的消息（OneBot CQ 字符串，不含 reply 引用） */
  messages: string[];
  /** 是否按「仅图片+画师」规则整形 */
  imageOnly: boolean;
}

/**
 * @param cleanedText extractOutboundMedia 清理后的正文
 * @param files       原始媒体文件路径（用于识别 PID）
 * @param sendPaths   与 files 一一对应的实际发送路径（可能是降噪后的文件）
 */
export function planDelivery(
  cleanedText: string,
  files: string[],
  sendPaths: string[],
  lookup: (p: string) => string | undefined = lookupPixivArtist,
  /** 用户这条消息自带图片附件时（在问「这是谁」之类），回复不按要图规则整形 */
  allowImageOnly = true,
): DeliveryPlan {
  const cq = (p: string) => `[CQ:image,file=file://${escapeCqParam(p)}]`;
  const imageIdx = files.map((f, i) => (isImageFile(f) ? i : -1)).filter(i => i >= 0);
  const otherIdx = files.map((_, i) => i).filter(i => !imageIdx.includes(i));
  const textArtists = extractArtistLines(cleanedText);
  const imageOnly = allowImageOnly && imageIdx.length > 0
    && (imageIdx.some(i => pixivPidOf(files[i]!)) || textArtists.length > 0);

  if (imageOnly) {
    // 回复里的画师行只有「一图一行」时才按位置对应；数量对不上就不猜，宁可不标画师也不张冠李戴
    const positional = textArtists.length === imageIdx.length;
    const single = new Set(textArtists).size === 1;
    const messages = imageIdx.map((fi, n) => {
      const artist = lookup(files[fi]!) ?? (positional ? textArtists[n] : single ? textArtists[0] : undefined);
      return artist ? `${cq(sendPaths[fi]!)}\n🎨 画师：${escapeCqText(artist)}` : cq(sendPaths[fi]!);
    });
    // 非图片媒体不能因为整形被丢掉：各自单独成条，沿用原有的 CQ 写法
    for (const i of otherIdx) messages.push(cq(sendPaths[i]!));
    return { messages, imageOnly: true };
  }

  // 非要图场景保持原有行为：媒体附在正文后面一并发送（正文里的 [ ] & 转义，防止模型输出被当成 CQ 码）
  const media = sendPaths.map(cq);
  const body = escapeCqText(cleanedText.trim());
  const joined = media.join('\n');
  const text = body && joined ? `${body}\n${joined}` : (body || joined);
  return { messages: text ? [text] : [], imageOnly: false };
}
