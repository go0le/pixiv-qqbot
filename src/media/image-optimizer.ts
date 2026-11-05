/**
 * 发图前的体积控制：图片超过 5MB 时降噪 + 重新编码到 5MB 以内再发送。
 *
 * - 原图不动；产物写成同目录的 `<原名>.dn.jpg`，目录里最终只留「原图 + 降噪成品」。
 * - 过程中的探测/候选文件是临时文件，无论成功失败都会删除。
 * - 依赖系统 ffmpeg/ffprobe（hqdn3d 降噪 + mjpeg 编码）。不可用或失败时返回原路径，由发送重试逻辑兜底。
 * - 透明通道会垫白底再转 JPEG。
 */
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** 5MB（按十进制取严，覆盖「5MB」的两种常见理解） */
export const MAX_SEND_IMAGE_BYTES = 5_000_000;

const OPTIMIZABLE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const DENOISE_FILTER = process.env.IMAGE_DENOISE_FILTER || 'hqdn3d=2:1.5:3:3';
const FFMPEG_TIMEOUT_MS = 90_000;
/** 依次尝试的缩放比例；每个比例内对 JPEG 质量做二分 */
const SCALES = [1, 0.85, 0.7, 0.55, 0.4];
/** 前几档缩放只接受不太糊的质量（ffmpeg mjpeg qscale，越小越好），最后一档放宽到 31 */
const Q_MIN = 2;
const Q_MAX_NORMAL = 12;
const Q_MAX_LAST = 31;

const inflight = new Map<string, Promise<string>>();

/**
 * ffmpeg 处理大图时内存很大（实测 189MB 的 PNG 峰值约 2.7GB），所以全局串行，
 * 多张大图同时到达也只排队处理，不并行。
 */
let queueTail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = queueTail.then(fn, fn);
  queueTail = job.catch(() => undefined);
  return job;
}

/** 读 JPEG 的 EXIF Orientation（1-8），读不到返回 1 */
function readJpegOrientation(path: string): number {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let off = 2;
    while (off + 4 < n) {
      if (buf[off] !== 0xff) return 1;
      const marker = buf[off + 1]!;
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
        const t = off + 10; // TIFF header
        const le = buf.toString('latin1', t, t + 2) === 'II';
        const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > n) return 1;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      if (marker === 0xda) return 1; // 图像数据开始，没有 EXIF
      off += 2 + len;
    }
  } catch {
    // ignore
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ }
  }
  return 1;
}

/** EXIF 方向 → ffmpeg 滤镜（先把像素转正，因为输出 JPEG 不再带方向标签） */
function orientationFilter(o: number): { filter: string; swap: boolean } {
  switch (o) {
    case 2: return { filter: 'hflip', swap: false };
    case 3: return { filter: 'hflip,vflip', swap: false };
    case 4: return { filter: 'vflip', swap: false };
    case 5: return { filter: 'transpose=0', swap: true };
    case 6: return { filter: 'transpose=1', swap: true };
    case 7: return { filter: 'transpose=3', swap: true };
    case 8: return { filter: 'transpose=2', swap: true };
    default: return { filter: '', swap: false };
  }
}

/** 动图 WebP（含 ANIM 块）压成单帧会毁掉内容，原样发送 */
function isAnimatedWebp(path: string): boolean {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('latin1', 0, n).includes('ANIM');
  } catch {
    return false;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

function safeUnlink(p: string): void {
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

function sizeOf(p: string): number {
  try { return statSync(p).size; } catch { return Number.POSITIVE_INFINITY; }
}

/** 降噪成品的路径：`<dir>/<stem>.dn.jpg` */
export function denoisedPathFor(srcPath: string): string {
  const ext = extname(srcPath);
  return join(dirname(srcPath), `${basename(srcPath, ext)}.dn.jpg`);
}

async function probeSize(src: string): Promise<{ w: number; h: number }> {
  const out = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', src,
  ]);
  const m = out.trim().match(/^(\d+)x(\d+)/);
  if (!m) throw new Error(`ffprobe returned no dimensions for ${src}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

async function encode(src: string, out: string, dims: { w: number; h: number }, scale: number, q: number, rot: { filter: string; swap: boolean }): Promise<number> {
  const bg = rot.swap ? { w: dims.h, h: dims.w } : dims;
  const scaleFilter = scale < 1 ? `,scale=trunc(iw*${scale}/2)*2:trunc(ih*${scale}/2)*2:flags=lanczos` : '';
  const graph = `[1:v]format=rgba${rot.filter ? `,${rot.filter}` : ''}[fg];[0:v][fg]overlay=shortest=1:format=auto,format=rgb24,${DENOISE_FILTER}${scaleFilter}[v]`;
  await run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=white:s=${bg.w}x${bg.h}`,
    '-i', src,
    '-filter_complex', graph,
    '-map', '[v]', '-frames:v', '1',
    '-q:v', String(q), '-pix_fmt', 'yuvj420p',
    '-f', 'image2', '-c:v', 'mjpeg', out,
  ]);
  return sizeOf(out);
}

async function shrink(src: string, finalPath: string, limit: number): Promise<string> {
  const dims = await probeSize(src);
  const rot = orientationFilter(/\.jpe?g$/i.test(src) ? readJpegOrientation(src) : 1);
  const token = randomBytes(4).toString('hex');
  const dir = dirname(finalPath);
  const best = join(dir, `.${basename(finalPath)}.${token}.best.tmp`);
  const probe = join(dir, `.${basename(finalPath)}.${token}.probe.tmp`);

  try {
    let found = false;
    for (let si = 0; si < SCALES.length && !found; si++) {
      const scale = SCALES[si]!;
      const qMax = si === SCALES.length - 1 ? Q_MAX_LAST : Q_MAX_NORMAL;
      // 先测最差质量：这一档连 qMax 都放不下就直接换更小的缩放，省掉无效二分
      if ((await encode(src, probe, dims, scale, qMax, rot)) >= limit) continue;
      // 二分找「仍小于 limit 的最小 q」（q 越小画质越好）
      let lo = Q_MIN;
      let hi = qMax; // hi 已验证可行
      renameSync(probe, best);
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await encode(src, probe, dims, scale, mid, rot)) < limit) {
          hi = mid;
          renameSync(probe, best); // 更好的可行解覆盖 best
        } else {
          lo = mid + 1;
        }
      }
      found = true;
    }
    if (!found) throw new Error(`cannot shrink ${basename(src)} below ${limit} bytes`);
    renameSync(best, finalPath);
    return finalPath;
  } finally {
    safeUnlink(probe);
    safeUnlink(best);
  }
}

/**
 * 返回可以直接发送的图片路径：体积未超限（或不适合处理）时是原路径，超限时是降噪后的 `.dn.jpg`。
 * 永不抛错：处理失败时记日志并回退原路径。
 */
export async function prepareImageForSend(srcPath: string, limit = MAX_SEND_IMAGE_BYTES): Promise<string> {
  try {
    if (!OPTIMIZABLE_EXTS.has(extname(srcPath).toLowerCase())) return srcPath;
    const srcStat = statSync(srcPath);
    if (srcStat.size <= limit) return srcPath;
    if (/\.webp$/i.test(srcPath) && isAnimatedWebp(srcPath)) return srcPath;

    const finalPath = denoisedPathFor(srcPath);
    // 已有可用成品且不比原图旧，直接复用
    if (existsSync(finalPath)) {
      const st = statSync(finalPath);
      if (st.size < limit && st.mtimeMs >= srcStat.mtimeMs) return finalPath;
    }

    let job = inflight.get(finalPath);
    if (!job) {
      const t0 = Date.now();
      job = serial(() => shrink(srcPath, finalPath, limit))
        .then(p => {
          console.log(`[ImageOptimizer] ${basename(srcPath)} ${(srcStat.size / 1e6).toFixed(1)}MB -> ${basename(p)} ${(sizeOf(p) / 1e6).toFixed(2)}MB (${Date.now() - t0}ms)`);
          return p;
        })
        .finally(() => { inflight.delete(finalPath); });
      inflight.set(finalPath, job);
    }
    return await job;
  } catch (err) {
    console.warn(`[ImageOptimizer] failed for ${srcPath}, sending original:`, err instanceof Error ? err.message : err);
    return srcPath;
  }
}
