/**
 * 多标签 AND、蹭标签/黑名单、明文灰名单。
 * 网络结果和本地缓存必须走同一套 passesRequestFilters。HTTP 全部 mock，不连真 Pixiv。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PixivService } from './service.ts';
import { PixivHistoryManager } from './history.ts';
import type { CachedPixivMetadata } from './types.ts';

const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0x01, 0x00, 0x00,
]);

const ENV_KEYS = ['PIXIV_REFRESH_TOKEN', 'PIXIV_PHPSESSID', 'PIXIV_COOKIE', 'PIXIV_PROXY_BASE_URL', 'PIXIV_LLM_TAGS'] as const;
const savedEnv = new Map<string, string | undefined>();

function rememberEnv(): void {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function work(partial: {
  id: string;
  tags: unknown;
  xRestrict?: number;
  omitRestrict?: boolean;
  aiType?: number;
  artist?: string;
  title?: string;
}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: partial.id,
    title: partial.title ?? partial.id,
    userName: partial.artist ?? '画师',
    illustType: 0,
    aiType: partial.aiType ?? 1,
    bookmarkCount: 500,
    createDate: new Date().toISOString(),
    tags: partial.tags,
    url: `https://i.pximg.net/img-original/img/2024/01/01/00/00/00/${partial.id}_p0.jpg`,
  };
  if (!partial.omitRestrict) row.xRestrict = partial.xRestrict ?? 0;
  return row;
}

function installAjax(works: Record<string, unknown>[]): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('i.pximg.net')) {
      return new Response(JPEG, { status: 200 });
    }
    return new Response(JSON.stringify({ error: false, body: { illust: { data: works } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
  return calls;
}

function makeService(dir: string): { service: PixivService; history: PixivHistoryManager } {
  const mediaDir = join(dir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const history = new PixivHistoryManager(join(dir, 'hist.json'));
  const service = new PixivService({
    mediaDir,
    metadataFile: join(dir, 'meta.json'),
    dynamicTagFile: join(dir, 'dyn.json'),
    historyManager: history,
  });
  return { service, history };
}

describe('Pixiv relevance: AND, unrelated tags, explicit greylist', () => {
  let dir = '';
  let service: PixivService | undefined;
  let history: PixivHistoryManager | undefined;

  afterEach(() => {
    history?.flushSync();
    service?.destroy();
    service = undefined;
    history = undefined;
    vi.unstubAllGlobals();
    restoreEnv();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup(): PixivService {
    rememberEnv();
    dir = mkdtempSync(join(tmpdir(), 'pixiv-rel-'));
    const made = makeService(dir);
    service = made.service;
    history = made.history;
    return service;
  }

  it('普通多标签是 AND：只中一个标签的网络结果丢掉，多出来的普通标签可以留', async () => {
    const svc = setup();
    const calls = installAjax([
      work({ id: 'only-ship', tags: ['信濃(アズールレーン)'] }),
      work({ id: 'only-swim', tags: ['水着'] }),
      work({
        id: 'both',
        tags: [
          { name: '信濃(アズールレーン)' },
          { name: '水着' },
          { name: '微笑' },
        ],
      }),
    ]);

    const result = await svc.searchIllustrations('group:and', ['信浓', '泳装'], 1);
    expect(result.illustrations.map(item => item.pid)).toEqual(['both']);
    const searchUrl = calls.find(url => url.includes('/ajax/search/'));
    expect(searchUrl).toBeTruthy();
    const decoded = decodeURIComponent(searchUrl!);
    expect(decoded).toContain('信濃(アズールレーン)');
    expect(decoded).toContain('水着');
    expect(decoded).toContain('mode=safe');
  });

  it('含灰名单短词的普通标签不能被从 AND 里删掉', () => {
    const svc = setup();
    const onlyShip = {
      pid: '1',
      title: 't',
      artist: 'a',
      tags: ['信濃(アズールレーン)'],
      bookmarks: 10,
      uploadDate: new Date().toISOString(),
      filePath: '/tmp/x.jpg',
      originalUrl: 'https://i.pximg.net/x.jpg',
      cachedAt: 1,
    } satisfies CachedPixivMetadata;
    const both = { ...onlyShip, tags: ['信濃(アズールレーン)', 'エロかわいい'] };
    const resolved = ['信濃(アズールレーン)', 'エロかわいい'];
    expect((svc as unknown as {
      matchMetadataTags: (m: CachedPixivMetadata, r: string[], raw: string[], g: Set<string>) => boolean;
    }).matchMetadataTags(onlyShip, resolved, ['信浓', 'エロかわいい'], new Set())).toBe(false);
    expect((svc as unknown as {
      matchMetadataTags: (m: CachedPixivMetadata, r: string[], raw: string[], g: Set<string>) => boolean;
    }).matchMetadataTags(both, resolved, ['信浓', 'エロかわいい'], new Set())).toBe(true);
  });

  it('本地缓存同样要求每个实质性标签都命中', async () => {
    const svc = setup();
    installAjax([]);
    const mediaDir = join(dir, 'media');
    const onlyPath = join(mediaDir, 'pixiv_only_p0.jpg');
    const bothPath = join(mediaDir, 'pixiv_both_p0.jpg');
    writeFileSync(onlyPath, JPEG);
    writeFileSync(bothPath, JPEG);
    const now = new Date().toISOString();
    const map = (svc as unknown as { metadataMap: Map<string, CachedPixivMetadata> }).metadataMap;
    map.set('only_p0', {
      pid: 'only',
      title: 'only',
      artist: 'a',
      tags: ['信濃(アズールレーン)'],
      bookmarks: 100,
      uploadDate: now,
      filePath: onlyPath,
      originalUrl: 'https://i.pximg.net/only.jpg',
      cachedAt: 1,
      xRestrict: 0,
      aiType: 1,
    });
    map.set('both_p0', {
      pid: 'both',
      title: 'both',
      artist: 'a',
      tags: ['信濃(アズールレーン)', '水着', '背景'],
      bookmarks: 90,
      uploadDate: now,
      filePath: bothPath,
      originalUrl: 'https://i.pximg.net/both.jpg',
      cachedAt: 1,
      xRestrict: 0,
      aiType: 1,
    });

    const result = await svc.searchIllustrations('group:local-and', '信浓 泳装', 1);
    expect(result.illustrations.map(item => item.pid)).toEqual(['both']);
  });

  it('无关图：同组角色叠标签、黑名单、AI 生成丢掉；多一个普通标签不算无关', async () => {
    const svc = setup();
    installAjax([
      work({
        id: 'piled',
        tags: ['信濃(アズールレーン)', 'アルザス(アズールレーン)'],
      }),
      work({
        id: 'meme',
        tags: ['信濃(アズールレーン)', '猎奇'],
      }),
      work({
        id: 'ai',
        tags: ['信濃(アズールレーン)', '笑顔'],
        aiType: 2,
      }),
      work({
        id: 'clean',
        tags: ['信濃(アズールレーン)', '笑顔', '背景'],
      }),
    ]);

    const result = await svc.searchIllustrations('group:clean', '信浓', 1);
    expect(result.illustrations.map(item => item.pid)).toEqual(['clean']);
  });

  it('默认避开灰名单；明文点名的类别必须命中，其它灰名单仍然不放行', async () => {
    const svc = setup();
    installAjax([
      work({ id: 'r18-oppai', tags: ['巨乳'], xRestrict: 1 }),
      work({ id: 'safe-oppai', tags: ['巨乳', '制服'], xRestrict: 0 }),
    ]);
    const safe = await svc.searchIllustrations('group:safe', '巨乳', 1);
    expect(safe.illustrations.map(item => item.pid)).toEqual(['safe-oppai']);

    const calls = installAjax([
      work({ id: 'fake-r18', tags: ['巨乳', 'R-18'], xRestrict: 0 }),
      work({ id: 'oral-only', tags: ['巨乳', 'フェラチオ'], xRestrict: 0 }),
      work({ id: 'real-r18', tags: ['巨乳'], xRestrict: 1 }),
    ]);
    const r18 = await svc.searchIllustrations('group:r18', ['r18', '巨乳'], 1);
    expect(r18.illustrations.map(item => item.pid)).toEqual(['real-r18']);
    expect(decodeURIComponent(calls.find(url => url.includes('/ajax/search/'))!)).toContain('mode=r18');

    installAjax([
      work({ id: 'just-oppai', tags: ['巨乳'], xRestrict: 0 }),
      work({ id: 'creampie', tags: ['巨乳', '中出し'], xRestrict: 1 }),
      work({ id: 'oral', tags: ['巨乳', 'フェラチオ', '微笑'], xRestrict: 0 }),
    ]);
    const oral = await svc.searchIllustrations('group:oral', ['口交', '巨乳'], 1);
    expect(oral.illustrations.map(item => item.pid)).toEqual(['oral']);
  });

  it('网页 mode=r18 的结果如果缺了 xRestrict，不当成全年龄图丢掉', async () => {
    const svc = setup();
    installAjax([
      work({ id: 'missing', tags: ['巨乳', '制服'], omitRestrict: true }),
      work({ id: 'explicit-safe', tags: ['巨乳', 'R-18'], xRestrict: 0 }),
    ]);
    const result = await svc.searchIllustrations('group:sparse-r18', ['ｒ１８', '巨乳'], 1);
    expect(result.illustrations.map(item => item.pid)).toEqual(['missing']);
    expect(result.illustrations[0]?.xRestrict).toBe(1);
  });

  it('配置了 refresh token 时走 app-api，并且仍然按 AND 过滤', async () => {
    const svc = setup();
    process.env.PIXIV_REFRESH_TOKEN = 'refresh-test';
    const seen: Array<{ url: string; authorization: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      seen.push({ url, authorization });
      if (url.includes('oauth.secure.pixiv.net')) {
        return new Response(JSON.stringify({
          response: { access_token: 'access-test', expires_in: 3600 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('i.pximg.net')) return new Response(JPEG, { status: 200 });
      return new Response(JSON.stringify({
        illusts: [
          {
            id: 11,
            title: 'only',
            type: 'illust',
            x_restrict: 0,
            illust_ai_type: 1,
            total_bookmarks: 100,
            create_date: new Date().toISOString(),
            user: { name: '画师甲' },
            tags: [{ name: '信濃(アズールレーン)' }],
            meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/img/a/11_p0.jpg' },
          },
          {
            id: 22,
            title: 'both',
            type: 'illust',
            x_restrict: 0,
            illust_ai_type: 1,
            total_bookmarks: 800,
            create_date: new Date().toISOString(),
            user: { name: '画师乙' },
            tags: [
              { name: '信濃(アズールレーン)' },
              { name: '水着' },
              { name: '微笑' },
            ],
            meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/img/a/22_p0.jpg' },
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await svc.searchIllustrations('group:app', ['信浓', '泳装'], 1);
    expect(result.illustrations.map(item => item.pid)).toEqual(['22']);
    expect(result.illustrations[0]?.artist).toBe('画师乙');
    const search = seen.find(call => call.url.includes('app-api.pixiv.net'));
    expect(search).toBeTruthy();
    expect(search!.authorization).toBe('Bearer access-test');
    expect(decodeURIComponent(search!.url)).toContain('水着');
    // 默认不加 for_ios（它会连带滤掉 Pixiv 标为「敏感」的全年龄图）；R-18 由 xRestrict 在本地拦截。PIXIV_SAFE_FILTER=1 才恢复。
    expect(search!.url).not.toContain('filter=for_ios');
  });
});
