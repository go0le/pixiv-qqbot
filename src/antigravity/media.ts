/**
 * Media attachment handler for Antigravity QQBot.
 *
 * Downloads incoming QQ image attachments to a local cache directory
 * and formats the prompt so that Antigravity's multimodal agent
 * can inspect the images using `read_file`.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface InboundAttachment {
  content_type?: string;
  url: string;
  filename?: string;
  size?: number;
}

export interface DownloadedMedia {
  localPath: string;
  contentType: string;
  filename: string;
}

export const MEDIA_CACHE_DIR = resolve(homedir(), '.dsh-qqbot', 'media');
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const DOWNLOAD_TIMEOUT_MS = 30_000;

function isImageAttachment(att: InboundAttachment): boolean {
  const ct = (att.content_type || '').toLowerCase();
  if (ct === 'image' || ct.startsWith('image/')) return true;
  const url = (att.url || '').toLowerCase();
  const exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
  return exts.some(ext => url.includes(ext) || (att.filename && att.filename.toLowerCase().endsWith(ext)));
}

function guessExtension(att: InboundAttachment): string {
  if (att.filename) {
    const ext = extname(att.filename);
    if (ext) return ext.toLowerCase();
  }
  const ct = (att.content_type || '').toLowerCase();
  if (ct === 'image/jpeg' || ct === 'image/jpg') return '.jpg';
  if (ct === 'image/png') return '.png';
  if (ct === 'image/gif') return '.gif';
  if (ct === 'image/webp') return '.webp';
  if (ct === 'image/svg+xml') return '.svg';

  const match = att.url.match(/\.(png|jpe?g|gif|webp|bmp|svg)(?:\?|$)/i);
  if (match && match[1]) {
    return `.${match[1].toLowerCase()}`;
  }
  return '.png';
}

function normalizeUrl(url: string): string {
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  return url;
}

export async function downloadImageAttachments(
  attachments: InboundAttachment[] | undefined,
  debug = false,
): Promise<DownloadedMedia[]> {
  if (!attachments || attachments.length === 0) return [];

  const imageTargets = attachments.filter(isImageAttachment);
  if (imageTargets.length === 0) return [];

  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  const downloaded: DownloadedMedia[] = [];

  for (const att of imageTargets) {
    try {
      const url = normalizeUrl(att.url);
      const ext = guessExtension(att);
      const rand = randomBytes(4).toString('hex');
      const filename = `qq_img_${Date.now()}_${rand}${ext}`;
      const localPath = join(MEDIA_CACHE_DIR, filename);

      if (debug) {
        console.log(`[QQBot Media] Downloading image from ${url} -> ${localPath}`);
      }

      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) {
        console.warn(`[QQBot Media] Download failed with HTTP ${res.status}: ${url}`);
        continue;
      }

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      if (buf.length > MAX_FILE_SIZE_BYTES) {
        console.warn(`[QQBot Media] Image exceeds ${MAX_FILE_SIZE_BYTES} bytes, skipping: ${url}`);
        continue;
      }

      writeFileSync(localPath, buf);
      downloaded.push({
        localPath,
        contentType: att.content_type || 'image/png',
        filename,
      });

      if (debug) {
        console.log(`[QQBot Media] Image downloaded successfully: ${localPath} (${buf.length} bytes)`);
      }
    } catch (err) {
      console.warn(`[QQBot Media] Failed to download image attachment:`, err);
    }
  }

  return downloaded;
}

export function buildPromptWithMedia(
  userText: string,
  media: DownloadedMedia[],
): string {
  const trimmed = userText.trim();
  if (media.length === 0) {
    return trimmed;
  }

  const imageList = media.map(m => `- \`${m.localPath}\``).join('\n');
  const question = trimmed.length > 0 ? trimmed : '请详细查看并描述这张图片的内容。';

  return [
    `[系统提示：用户在 QQ 中发送了 ${media.length} 张图片附件，已成功下载至本地目录：]`,
    imageList,
    `请务必使用你的 \`read_file\` 工具读取该本地图片，结合图像中的视觉内容与信息来回答用户。`,
    ``,
    `用户的问题/输入:`,
    question,
  ].join('\n');
}

export interface OutboundMediaResult {
  cleanedText: string;
  filesToSend: string[];
}

export const ALLOWED_OUTBOUND_MEDIA_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.silk',
  '.amr',
]);

/**
 * 扫描 Agent 回复内容中包含的本地媒体（图片/音视频）引用，
 * 仅允许受信扩展名的真实富媒体文件投递，坚决禁止将服务器代码、文档(.md)、配置与数据库文件发送给用户；
 * 同时净化 Markdown 链接，防止在 QQ 客户端渲染为死链接或泄露服务器敏感文件路径。
 */
export function extractOutboundMedia(
  text: string,
  cwd = process.cwd(),
): OutboundMediaResult {
  if (!text) {
    return { cleanedText: '', filesToSend: [] };
  }

  const filesToSend: string[] = [];
  const seenBasenames = new Set<string>();

  const checkAndRecord = (rawPath: string): boolean => {
    let p = decodeURIComponent(rawPath.trim());
    if (p.startsWith('file://')) {
      p = p.replace(/^file:\/\//, '');
    }
    // 剥离可能存在的行号锚点 (e.g. #L10-L20)
    p = p.replace(/#.*$/, '');

    if (!isAbsolute(p)) {
      p = resolve(cwd, p);
    }

    const ext = extname(p).toLowerCase();
    // 严格安全白名单：仅放行常见音视频与图片，严禁向 QQ 用户投递 .md、.ts、.json、.db、.env 等服务器文件
    if (!ALLOWED_OUTBOUND_MEDIA_EXTS.has(ext)) {
      return false;
    }

    try {
      if (existsSync(p) && statSync(p).isFile()) {
        const base = basename(p);
        if (!seenBasenames.has(base)) {
          seenBasenames.add(base);
          filesToSend.push(p);
        }
        return true;
      }
    } catch {}
    return false;
  };

  // 1. 匹配 Markdown 图片：![alt](path) 或 ![alt](file:///path)
  let cleaned = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, _alt, rawPath) => {
    if (checkAndRecord(rawPath)) {
      return '';
    }
    return match;
  });

  // 2. 匹配 Markdown 文件链接：[label](file:///path) 或 [label](/path)
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, rawPath) => {
    if (rawPath.startsWith('file://') || rawPath.startsWith('/') || rawPath.startsWith('./')) {
      if (checkAndRecord(rawPath)) {
        // 是合法媒体文件（如 [原图](file:///.../pic.png)），提取发送并从文本中抹除
        return '';
      }
      // 非媒体文件（如 [v3.md](file:///.../v3.md) 或 [service.ts](file:///...)），严禁作为文件外发！
      // 净化为纯文本标签展示，不泄露服务器绝对路径，也不触发文件投递
      return label;
    }
    return match;
  });

  // 3. 抹除可能泄露服务器敏感目录的直接绝对路径暴露
  cleaned = cleaned.replace(/file:\/\/\S+/g, '');

  // 收敛多余的空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return {
    cleanedText: cleaned,
    filesToSend,
  };
}
