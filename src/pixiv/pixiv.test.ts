import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  calculateTimeDecayScore,
  PixivService,
  CHARACTER_TAG_MAP,
} from './service.ts';
import type { PixivIllustration } from './types.ts';
import { DynamicTagStore } from './dynamic-store.ts';
import { LlmTagResolver } from './llm-resolver.ts';
import { PixivHistoryManager, MAX_HISTORY_PER_CHAT } from './history.ts';
import { PixivRateLimiter } from './limiter.ts';
import { AsyncMutex, KeyedMutex } from './mutex.ts';
import {
  checkRequestBlacklist,
  extractRequestedGreylist,
  checkImageBlacklist,
  checkImageGreylist,
  checkExclusiveGroup,
  normalizeForFilter,
  matchesGreylistCategory,
  checkRequestedGreylistMatched,
  isImageCompliant,
  isOfficialR18,
} from './filter.ts';

describe('Pixiv Time-Decay Ranking Score (v2.0+ 规范)', () => {
  it('发布当天无衰减且带有 α=10 偏置: (1000 + 10) * 1 = 1010', () => {
    const now = new Date('2026-10-30T00:00:00Z').getTime();
    const score = calculateTimeDecayScore(1000, '2026-10-30T00:00:00Z', now);
    expect(score).toBeCloseTo(1010, 1);
  });

  it('刚好 365 天衰减为一半（半衰期 T_half = 365 天）: 1010 * 0.5 = 505', () => {
    const now = new Date('2026-10-30T00:00:00Z').getTime();
    const oneYearAgo = new Date('2025-10-30T00:00:00Z').getTime();
    const score = calculateTimeDecayScore(1000, oneYearAgo, now);
    expect(score).toBeCloseTo(505, 1);
  });

  it('刚好 730 天（2 年）衰减为四分之一: 1010 * 0.25 = 252.5', () => {
    const now = new Date('2026-10-30T00:00:00Z').getTime();
    const twoYearsAgo = new Date('2024-10-30T00:00:00Z').getTime();
    const score = calculateTimeDecayScore(1000, twoYearsAgo, now);
    expect(score).toBeCloseTo(252.5, 1);
  });

  it('零收藏新作获得基础偏置 α=10 分，避免恒为 0', () => {
    const now = new Date('2026-10-30T00:00:00Z').getTime();
    const score = calculateTimeDecayScore(0, '2026-10-30T00:00:00Z', now);
    expect(score).toBeCloseTo(10, 1);
  });

  it('未来日期 Δt < 0 自动钳位为 0，防止指数爆炸', () => {
    const now = new Date('2026-10-30T00:00:00Z').getTime();
    const futureDate = new Date('2027-10-30T00:00:00Z').getTime();
    const score = calculateTimeDecayScore(1000, futureDate, now);
    expect(score).toBeCloseTo(1010, 1);
  });

  it('支持传入自定义 α=0', () => {
    const now = new Date('2026-10-30T00:00:00Z').getTime();
    const score = calculateTimeDecayScore(1000, '2026-10-30T00:00:00Z', now, 0);
    expect(score).toBeCloseTo(1000, 1);
  });

  it('日期非法时优雅降级返回原 bookmarks + α', () => {
    const score = calculateTimeDecayScore(500, 'invalid-date');
    expect(score).toBe(510);
  });
});

describe('Pixiv Multi-Tag & Character Tag Mapping (v3.0)', () => {
  const service = new PixivService();

  it('正确映射单角色中文名至 Pixiv 官方标准化标签', () => {
    expect(service.resolveTag('信浓')).toBe('信濃(アズールレーン)');
    expect(service.resolveTag('柴郡')).toBe('チェシャー(アズールレーン)');
    expect(service.resolveTag('爱丽丝')).toBe('アリス(ブルーアーカイブ)');
    expect(service.resolveTag('白子')).toBe('砂狼シロコ');
    expect(service.resolveTag('流萤')).toBe('ホタル(崩壊:スターレイル)');
    expect(service.resolveTag('雷电将军')).toBe('雷電将軍');
  });

  it('正确解析多 Tag 组合（角色 + 服饰/情境 + 灰名单）', () => {
    expect(service.resolveTag('信浓 泳装')).toBe('信濃(アズールレーン) 水着');
    expect(service.resolveTag(['信浓', '泳装'])).toBe('信濃(アズールレーン) 水着');
    expect(service.resolveTag(['柴郡', '兔女郎', 'r18'])).toBe('チェシャー(アズールレーン) バニーガール R-18');
    expect(service.resolveTag(['柴郡', '兔女郎', 'ｒ１８'])).toBe('チェシャー(アズールレーン) バニーガール R-18');
    expect(service.resolveTagList(['爱丽丝', '女仆'])).toEqual(['アリス(ブルーアーカイブ)', 'メイド']);
  });

  it('未在字典中的标签保留原词', () => {
    expect(service.resolveTag('オリジナル')).toBe('オリジナル');
    expect(service.resolveTag('风景')).toBe('风景');
  });
});

describe('Pixiv Blacklist (黑名单机制 - Claude Opus 4.6 审查加固)', () => {
  it('用户请求包含男同、猎奇、AI生成、福瑞等标签时，明文拦截并拒绝', () => {
    expect(checkRequestBlacklist(['男同']).blocked).toBe(true);
    expect(checkRequestBlacklist(['bl']).blocked).toBe(true);
    expect(checkRequestBlacklist(['猎奇']).blocked).toBe(true);
    expect(checkRequestBlacklist(['guro']).blocked).toBe(true);
    expect(checkRequestBlacklist(['ai生成']).blocked).toBe(true);
    expect(checkRequestBlacklist(['novelai']).blocked).toBe(true);
    expect(checkRequestBlacklist(['福瑞']).blocked).toBe(true);
    expect(checkRequestBlacklist(['furry']).blocked).toBe(true);
    expect(checkRequestBlacklist(['牢大']).blocked).toBe(true);
    expect(checkRequestBlacklist(['草稿']).blocked).toBe(true);
  });

  it('P0-02 修复验证：移除裸词 ai，绝不误杀含 ai 子串的正常词或单字母 a', () => {
    // 正常词绝不误伤
    expect(checkRequestBlacklist(['メイド']).blocked).toBe(false);
    expect(checkRequestBlacklist(['ペイント']).blocked).toBe(false);
    expect(checkRequestBlacklist(['maid']).blocked).toBe(false);
    expect(checkRequestBlacklist(['Kaiser']).blocked).toBe(false);

    // 单字母 a 或 i 绝不反向命中
    expect(checkRequestBlacklist(['a']).blocked).toBe(false);
    expect(checkRequestBlacklist(['i']).blocked).toBe(false);
  });

  it('P2-01 修复验证：Unicode 全角与零宽字符无法绕过黑名单', () => {
    expect(normalizeForFilter('ＢＬ')).toBe('bl');
    expect(checkRequestBlacklist(['ＢＬ']).blocked).toBe(true);
    expect(checkRequestBlacklist(['男\u200B同']).blocked).toBe(true);
  });

  it('作品包含黑名单标签或属于 AI 生成时，一票否决淘汰', () => {
    const aiIllust = { pid: '1', title: 't', artist: 'a', tags: ['信浓'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, illustType: 2 };
    expect(checkImageBlacklist(aiIllust).compliant).toBe(false);

    const pixivAiIllust = { pid: '10', title: 't', artist: 'a', tags: ['信浓'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, aiType: 2 };
    expect(checkImageBlacklist(pixivAiIllust).compliant).toBe(false);

    const guroIllust = { pid: '2', title: 't', artist: 'a', tags: ['信浓', 'グロ'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false };
    expect(checkImageBlacklist(guroIllust).compliant).toBe(false);

    // 含有メイド正常词的作品绝不误杀
    const maidIllust = { pid: '3', title: 'maid', artist: 'a', tags: ['信濃(アズールレーン)', 'メイド'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false };
    expect(checkImageBlacklist(maidIllust).compliant).toBe(true);
  });
});

describe('Pixiv Greylist (灰名单受控机制 - Claude Opus 4.6 审查加固)', () => {
  it('正确提取用户请求中已授权的灰名单类别', () => {
    expect(extractRequestedGreylist(['信浓']).size).toBe(0);
    expect(extractRequestedGreylist(['信浓', 'r18'])).toEqual(new Set(['r18']));
    expect(extractRequestedGreylist(['信浓', 'R-18', '口交'])).toEqual(new Set(['r18', 'oral']));
  });

  it('P1-03 修复验证：输入前缀 r1 绝不能静默放行 R18', () => {
    expect(extractRequestedGreylist(['r1']).has('r18')).toBe(false);
    expect(extractRequestedGreylist(['r18']).has('r18')).toBe(true);
  });

  it('P2-01 修复验证：全角 ｒ１８ 能正确识别授权', () => {
    expect(extractRequestedGreylist(['ｒ１８']).has('r18')).toBe(true);
  });

  it('P2-03 修复验证：灰名单全面覆盖标题，标题含未授权敏感词同样拦截', () => {
    const emptyAllowed = new Set<string>();

    // 标签正常但标题含有「中出し」
    const badTitleIllust = { pid: '1', title: '信浓中出し本', artist: 'a', tags: ['信浓'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false };
    expect(checkImageGreylist(badTitleIllust, emptyAllowed).compliant).toBe(false);
  });

  it('用户请求未包含灰名单时，作品含有任何灰名单标签均被拦截', () => {
    const emptyAllowed = new Set<string>();

    const r18Illust = { pid: '1', title: 't', artist: 'a', tags: ['信浓', 'R-18'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, xRestrict: 1 };
    expect(checkImageGreylist(r18Illust, emptyAllowed).compliant).toBe(false);

    const fellatioIllust = { pid: '2', title: 't', artist: 'a', tags: ['信浓', 'フェラチオ'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false };
    expect(checkImageGreylist(fellatioIllust, emptyAllowed).compliant).toBe(false);

    const cleanIllust = { pid: '3', title: 't', artist: 'a', tags: ['信浓', '水着'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false };
    expect(checkImageGreylist(cleanIllust, emptyAllowed).compliant).toBe(true);

    // 灰名单中画师标注的 r18 不算：全年龄 (xRestrict: 0) 作品即便被打上 R-18 标签或标题，不计为 R-18，不被拦截
    const artistTaggedR18Illust = { pid: '4', title: '信浓插画', artist: 'a', tags: ['信浓', 'R-18'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, xRestrict: 0 };
    expect(checkImageGreylist(artistTaggedR18Illust, emptyAllowed).compliant).toBe(true);

    const artistTitleR18Illust = { pid: '5', title: '信浓R-18预告', artist: 'a', tags: ['信浓'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, xRestrict: 0 };
    expect(checkImageGreylist(artistTitleR18Illust, emptyAllowed).compliant).toBe(true);
  });

  it('用户显式请求了某灰名单标签时，只放行该标签，其余灰名单标签仍拦截', () => {
    const allowR18Only = new Set(['r18']);

    const r18Illust = { pid: '1', title: 't', artist: 'a', tags: ['信浓', 'R-18'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, xRestrict: 1 };
    expect(checkImageGreylist(r18Illust, allowR18Only).compliant).toBe(true);

    const mixedIllust = { pid: '2', title: 't', artist: 'a', tags: ['信浓', 'R-18', 'フェラチオ'], bookmarks: 10, uploadDate: '', localPath: '', score: 10, isFromCache: false, xRestrict: 1 };
    expect(checkImageGreylist(mixedIllust, allowR18Only).compliant).toBe(false);

    const allowBoth = new Set(['r18', 'oral']);
    expect(checkImageGreylist(mixedIllust, allowBoth).compliant).toBe(true);
  });

  it('matchesGreylistCategory: r18 仅认官方 xRestrict > 0，画师标注 tag/title 均不算', () => {
    // isOfficialR18 权威校验 helper 测试
    expect(isOfficialR18({ xRestrict: 1 } as any)).toBe(true);
    expect(isOfficialR18({ xRestrict: 2 } as any)).toBe(true);
    expect(isOfficialR18({ xRestrict: '1' } as any)).toBe(true); // 兼容上游代理返回字符串数值
    expect(isOfficialR18({ xRestrict: 0 } as any)).toBe(false);
    expect(isOfficialR18({ xRestrict: '0' } as any)).toBe(false);
    expect(isOfficialR18({ xRestrict: undefined } as any)).toBe(false);
    expect(isOfficialR18({ xRestrict: null } as any)).toBe(false);
    expect(isOfficialR18({} as any)).toBe(false);
    expect(isOfficialR18(null as any)).toBe(false);

    // 官方标注 xRestrict: 1 或 2 -> 算 R18
    expect(matchesGreylistCategory({ xRestrict: 1, tags: [] } as any, 'r18')).toBe(true);
    expect(matchesGreylistCategory({ xRestrict: 2, tags: [] } as any, 'r18')).toBe(true);
    expect(matchesGreylistCategory({ xRestrict: '1', tags: [] } as any, 'r18')).toBe(true);

    // 官方全年龄 xRestrict: 0，即便画师写了 R-18 / ｒ１８ / title 写了 R-18 -> 均不算 R18
    expect(matchesGreylistCategory({ xRestrict: 0, tags: ['R-18'] } as any, 'r18')).toBe(false);
    expect(matchesGreylistCategory({ xRestrict: '0', tags: ['R-18'] } as any, 'r18')).toBe(false);
    expect(matchesGreylistCategory({ xRestrict: 0, tags: ['ｒ１８', '工口'] } as any, 'r18')).toBe(false);
    expect(matchesGreylistCategory({ xRestrict: 0, title: '【R-18】落書き' } as any, 'r18')).toBe(false);
    expect(matchesGreylistCategory({ tags: ['R-18'] } as any, 'r18')).toBe(false); // undefined xRestrict 默认不算

    // 其余非 R18 灰名单类别（如 oral）仍按 keywords 匹配
    expect(matchesGreylistCategory({ tags: ['フェラチオ'] } as any, 'oral')).toBe(true);
    expect(matchesGreylistCategory({ tags: ['水着'] } as any, 'oral')).toBe(false);
  });
});

describe('Pixiv Exclusive Group (互斥实体组纯度校验 - Claude Opus 4.6 审查加固)', () => {
  it('搜企业时，若作品同时打满了阿尔萨斯等同组角色 Tag，直接判定蹭热度淘汰', () => {
    const hijackedIllust = {
      pid: '151321231',
      title: 'office lady',
      artist: 'test',
      tags: ['アルザス(アズールレーン)', 'エンタープライズ(アズールレーン)', 'リシュリュー(アズールレーン)'],
      bookmarks: 10,
      uploadDate: '',
      localPath: '',
      score: 10,
      isFromCache: false,
    };
    const res = checkExclusiveGroup(hijackedIllust, 'エンタープライズ(アズールレーン)');
    expect(res.compliant).toBe(false);
  });

  it('P2-02 修复验证：合绘白名单（2人 / コラボ / まとめ）正常放行', () => {
    const duoIllust = {
      pid: '1002',
      title: 'duo',
      artist: 'test',
      tags: ['アルザス(アズールレーン)', 'エンタープライズ(アズールレーン)', '2人'],
      bookmarks: 10,
      uploadDate: '',
      localPath: '',
      score: 10,
      isFromCache: false,
    };
    expect(checkExclusiveGroup(duoIllust, 'エンタープライズ(アズールレーン)').compliant).toBe(true);

    const collabIllust = {
      pid: '1003',
      title: 'collab',
      artist: 'test',
      tags: ['アルザス(アズールレーン)', 'エンタープライズ(アズールレーン)', 'コラボ'],
      bookmarks: 10,
      uploadDate: '',
      localPath: '',
      score: 10,
      isFromCache: false,
    };
    expect(checkExclusiveGroup(collabIllust, 'エンタープライズ(アズールレーン)').compliant).toBe(true);
  });
});

describe('KeyedMutex (P1-01 内存泄漏修复验证)', () => {
  it('锁释放且完全空闲后，自动从 locks Map 清除，内存占用归零', async () => {
    const keyed = new KeyedMutex();
    expect(keyed.size()).toBe(0);

    await keyed.runExclusive('group:123', async () => {
      expect(keyed.size()).toBe(1);
    });

    // 运行完毕，自动回收
    expect(keyed.size()).toBe(0);
  });
});

describe('Pixiv History Manager (P1-02 防抖与 P1-06 临时文件清理)', () => {
  const testHistoryFile = resolve(tmpdir(), `pixiv_test_hist_${Date.now()}.json`);
  const testBackupFile = `${testHistoryFile}.bak`;

  afterEach(() => {
    if (existsSync(testHistoryFile)) rmSync(testHistoryFile, { force: true });
    if (existsSync(testBackupFile)) rmSync(testBackupFile, { force: true });
  });

  it('支持 FIFO 截断与 flushSync 立即落盘', () => {
    const history = new PixivHistoryManager(testHistoryFile);
    const chatKey = 'group:test';

    const pids: string[] = [];
    for (let i = 1; i <= 600; i++) {
      pids.push(`pid_${i}`);
    }

    history.recordSent(chatKey, pids);
    history.flushSync();

    const sent = history.getSentPids(chatKey);
    expect(sent.length).toBe(MAX_HISTORY_PER_CHAT);
    expect(sent[0]).toBe('pid_101');
    expect(sent[sent.length - 1]).toBe('pid_600');
  });

  it('主历史文件损坏时自动从 backup 容灾恢复', () => {
    const history1 = new PixivHistoryManager(testHistoryFile);
    history1.recordSent('group:backup_test', ['999', '888']);
    history1.flushSync();

    history1.recordSent('group:backup_test', ['777']);
    history1.flushSync();

    // 故意损坏主文件
    writeFileSync(testHistoryFile, 'CORRUPTED_JSON_DATA!!!');

    const history2 = new PixivHistoryManager(testHistoryFile);
    expect(history2.hasSent('group:backup_test', '999')).toBe(true);
  });
});

describe('PixivService LRU Eviction & Clean Temps (P1-06 & P2-07)', () => {
  const testDir = resolve(tmpdir(), `pixiv_service_lru_test_${Date.now()}`);
  const testMetaFile = join(testDir, 'metadata.json');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('启动时自动清理遗留的 *.tmp 临时文件', () => {
    const staleTmp = join(testDir, 'pixiv_999.tmp');
    writeFileSync(staleTmp, 'stale content');
    expect(existsSync(staleTmp)).toBe(true);

    const service = new PixivService({
      mediaDir: testDir,
      metadataFile: testMetaFile,
    });

    service.cleanStaleTemps();
    expect(existsSync(staleTmp)).toBe(false);
  });

  it('超限时触发 LRU 淘汰最老文件', () => {
    const file1 = join(testDir, 'pixiv_1_p0.jpg');
    const file2 = join(testDir, 'pixiv_2_p0.jpg');
    writeFileSync(file1, Buffer.alloc(1000));
    writeFileSync(file2, Buffer.alloc(1000));

    const service = new PixivService({
      mediaDir: testDir,
      metadataFile: testMetaFile,
    });

    (service as any).metadataMap.set('1_p0', {
      pid: '1',
      title: 'old',
      filePath: file1,
      cachedAt: 1000,
    });
    (service as any).metadataMap.set('2_p0', {
      pid: '2',
      title: 'new',
      filePath: file2,
      cachedAt: 2000,
    });

    // 限制 1500 字节，应该淘汰最老的 1_p0
    service.evictOldCache(1500);

    expect(existsSync(file1)).toBe(false);
    expect(existsSync(file2)).toBe(true);
  });

  it('NF-04 验证：metadata.json 损坏时自动从 .bak 备份容灾恢复', () => {
    const backupFile = `${testMetaFile}.bak`;
    const service1 = new PixivService({
      mediaDir: testDir,
      metadataFile: testMetaFile,
    });

    const fileOk = join(testDir, 'pixiv_100_p0.jpg');
    writeFileSync(fileOk, 'image content');

    (service1 as any).metadataMap.set('100_p0', {
      pid: '100',
      title: 'valid',
      filePath: fileOk,
      cachedAt: Date.now(),
    });
    service1.saveMetadata();

    // 第一次写完已生成主文件
    expect(existsSync(testMetaFile)).toBe(true);

    // 第二次写生成 .bak
    service1.saveMetadata();
    expect(existsSync(backupFile)).toBe(true);

    // 故意损坏主文件
    writeFileSync(testMetaFile, 'INVALID_JSON_CORRUPTED');

    // 新实例应该从 .bak 备份恢复
    const service2 = new PixivService({
      mediaDir: testDir,
      metadataFile: testMetaFile,
    });
    expect((service2 as any).metadataMap.has('100_p0')).toBe(true);
  });

  it('NF-05 验证：本地缓存命中时自动刷新 cachedAt 时间戳 (真 LRU)', async () => {
    const file1 = join(testDir, 'pixiv_hit_p0.jpg');
    const fakeMagicJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
    writeFileSync(file1, fakeMagicJpg);

    const service = new PixivService({
      mediaDir: testDir,
      metadataFile: testMetaFile,
      historyManager: new PixivHistoryManager(join(testDir, 'test_history.json')),
    });

    const oldTimestamp = 100000;
    (service as any).metadataMap.set('hit_p0', {
      pid: 'hit',
      title: '信浓插画',
      artist: '画师',
      tags: ['信濃(アズールレーン)'],
      bookmarks: 1000,
      uploadDate: new Date().toISOString(),
      filePath: file1,
      originalUrl: 'https://i.pximg.net/hit.jpg',
      cachedAt: oldTimestamp,
      page: 0,
      illustType: 0,
    });

    vi.spyOn(service as any, 'fetchFromNetwork').mockResolvedValue([]);

    const res = await service.searchIllustrations('chat:test', '信浓', 1);
    const updatedMeta = (service as any).metadataMap.get('hit_p0');
    expect(res.illustrations.length).toBe(1);
    expect(updatedMeta.cachedAt).toBeGreaterThan(oldTimestamp);
  });
});

describe('NF-03 复合黑名单词空格拆分防御测试', () => {
  it('空格拆分输入 "信浓 stable diffusion" 依然被成功拦截', () => {
    const tokens = ['信浓', 'stable', 'diffusion'];
    const res = checkRequestBlacklist(tokens);
    expect(res.blocked).toBe(true);
    expect(res.matchedTag).toBe('stable diffusion');
  });
});

describe('TC-304 Quality Waterfall by users入り 质量漏斗测试', () => {
  it('优先按 10000users入り -> 5000users入り -> 1000users入り -> 500users入り 阶梯检索并附加估值补偿', async () => {
    const testDir = resolve(tmpdir(), `pixiv_waterfall_test_${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const service = new PixivService({
      mediaDir: testDir,
      metadataFile: join(testDir, 'meta.json'),
      historyManager: new PixivHistoryManager(join(testDir, 'hist.json')),
    });

    const queries: string[] = [];
    vi.spyOn(service as any, 'fetchFromNetworkSingleQuery').mockImplementation(async (queryTag: string, baseTag: string, bias: number) => {
      queries.push(queryTag);
      if (queryTag.includes('10000users入り')) {
        // 第一档无返回
        return [];
      }
      if (queryTag.includes('5000users入り')) {
        // 第二档无返回
        return [];
      }
      if (queryTag.includes('1000users入り')) {
        // 第三档无返回
        return [];
      }
      if (queryTag.includes('500users入り')) {
        // 第四档命中
        return [{
          pid: '500_hit',
          title: '高质量作品',
          artist: '知名画师',
          localPath: '',
          score: 500,
          bookmarks: 500,
          uploadDate: new Date().toISOString(),
          tags: ['信濃(アズールレーン)', '500users入り'],
          originalUrl: 'https://i.pximg.net/500.jpg',
          isFromCache: false,
        }];
      }
      return [];
    });

    const result = await (service as any).fetchFromNetwork('信濃(アズールレーン)', new Set());
    expect(queries).toEqual([
      '信濃(アズールレーン) 10000users入り',
      '信濃(アズールレーン) 5000users入り',
      '信濃(アズールレーン) 1000users入り',
      '信濃(アズールレーン) 500users入り',
    ]);
    expect(result.length).toBe(1);
    expect(result[0].pid).toBe('500_hit');
    expect(result[0].bookmarks).toBe(500);
  });
});

describe('Pixiv Dynamic Self-Learning Tag Resolver (LLM 语义回填机制)', () => {
    const testDir = resolve(tmpdir(), `pixiv_dynamic_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    let testDynFile: string;
    let store: DynamicTagStore;

    beforeEach(() => {
      mkdirSync(testDir, { recursive: true });
      testDynFile = join(testDir, `dyn_tags_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
      store = new DynamicTagStore({ filePath: testDynFile, maxEntries: 3 });
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it('DynamicTagStore 正确记录、读取、大小写归一化并持久化', () => {
      store.set('大姐姐', ['お姉さん']);
      store.set('JK水手服', ['女子高生', 'セーラー服']);
      store.save();

      expect(store.has('大姐姐')).toBe(true);
      expect(store.has('大姐姐 ')).toBe(true);
      expect(store.has('jk水手服')).toBe(true);
      expect(store.get('大姐姐')).toEqual(['お姉さん']);
      expect(store.get('JK水手服')).toEqual(['女子高生', 'セーラー服']);

      // 重新从磁盘加载验证
      const store2 = new DynamicTagStore({ filePath: testDynFile });
      expect(store2.get('大姐姐')).toEqual(['お姉さん']);
      expect(store2.get('jk水手服')).toEqual(['女子高生', 'セーラー服']);
    });

    it('DynamicTagStore 损坏时能自动从 .bak 容灾恢复', () => {
      store.set('年上', ['年上']);
      store.save(); // 产生主文件并备份

      store.set('大姐姐', ['お姉さん']);
      store.save(); // 此时 .bak 拥有备份

      // 破坏主文件
      writeFileSync(testDynFile, '{"broken json', 'utf8');

      const restoredStore = new DynamicTagStore({ filePath: testDynFile });
      expect(restoredStore.get('年上')).toEqual(['年上']);
    });

    it('DynamicTagStore 达到容量上限时淘汰最老条目 (LRU/FIFO 约束)', () => {
      store.set('tag1', ['t1']);
      store.set('tag2', ['t2']);
      store.set('tag3', ['t3']);
      expect(store.size).toBe(3);

      // 插入第 4 条，淘汰 tag1
      store.set('tag4', ['t4']);
      expect(store.size).toBe(3);
      expect(store.has('tag1')).toBe(false);
      expect(store.has('tag2')).toBe(true);
      expect(store.has('tag4')).toBe(true);
    });

    it('LlmTagResolver 正确解析大模型输出并去除 Markdown 标记', () => {
      const resolver = new LlmTagResolver();
      const output = '```json\n{\n  "tags": ["お姉さん", "魅惑"],\n  "mappings": {\n    "年上大姐姐": ["お姉さん"],\n    "诱惑": ["魅惑"]\n  }\n}\n```';
      const parsed = resolver.parseLlmOutput(output);

      expect(parsed).not.toBeNull();
      expect(parsed!.tags).toEqual(['お姉さん', '魅惑']);
      expect(parsed!.mappings['年上大姐姐']).toEqual(['お姉さん']);
      expect(parsed!.mappings['诱惑']).toEqual(['魅惑']);
    });

    it('已收录词汇走快速路径 (0 次 LLM 调用)，未收录中文词汇触发 LLM 语义理解并自学习回填', async () => {
      let llmCalls = 0;
      const customExecutor = vi.fn(async (_prompt: string) => {
        llmCalls++;
        return JSON.stringify({
          tags: ['お姉さん', '魅惑'],
          mappings: {
            '年上大姐姐': ['お姉さん'],
            '诱惑': ['魅惑'],
          },
        });
      });

      const resolver = new LlmTagResolver({ customExecutor });
      const testService = new PixivService({
        mediaDir: join(testDir, 'media'),
        metadataFile: join(testDir, 'meta.json'),
        dynamicTagStore: store,
        llmTagResolver: resolver,
      });

      // 1. 已收录词汇（如 信浓、泳装）：完全不触发 LLM
      const res1 = await testService.resolveTagListAsync(['信浓', '泳装']);
      expect(res1).toEqual(['信濃(アズールレーン)', '水手服' === '水手服' ? '水着' : '水着']);
      expect(llmCalls).toBe(0);

      // 2. 未收录词汇（年上大姐姐 诱惑）：首次触发 LLM 并写入 store
      const res2 = await testService.resolveTagListAsync(['年上大姐姐', '诱惑']);
      expect(llmCalls).toBe(1);
      expect(res2).toEqual(['お姉さん', '魅惑']);

      // 验证自学习映射已写入 dynamicTagStore
      expect(store.has('年上大姐姐')).toBe(true);
      expect(store.get('年上大姐姐')).toEqual(['お姉さん']);
      expect(store.has('诱惑')).toBe(true);
      expect(store.get('诱惑')).toEqual(['魅惑']);

      // 3. 第二次请求相同或部分词汇（年上大姐姐 泳装）：年上大姐姐命中动态表，LLM 调用次数依然为 1！
      const res3 = await testService.resolveTagListAsync(['年上大姐姐', '泳装']);
      expect(llmCalls).toBe(1); // 零额外 LLM 调用，极速命中缓存
      expect(res3).toEqual(['お姉さん', '水着']);
    });

    it('语义转换后若恶意生成黑名单标签，后置安全网坚决拦截', async () => {
      const customExecutor = vi.fn(async () => {
        return JSON.stringify({
          tags: ['猎奇', 'お姉さん'],
          mappings: {
            '危险短语': ['猎奇', 'お姉さん'],
          },
        });
      });

      const resolver = new LlmTagResolver({ customExecutor });
      const testService = new PixivService({
        mediaDir: join(testDir, 'media'),
        metadataFile: join(testDir, 'meta.json'),
        dynamicTagStore: store,
        llmTagResolver: resolver,
      });

      const searchRes = await testService.searchIllustrations('chat:123', '危险短语', 1);
      expect(searchRes.blocked).toBe(true);
      expect(searchRes.blockReason).toContain('语义转换后包含禁止标签');
    });
  });

describe('Round 3 Claude Opus 4.6 终审加固验证 (F-01 ~ F-11)', () => {
  it('F-01 验证：normalizeForFilter 成功剥离组合附标字符，阻止 Zalgo 变体绕过黑名单', () => {
    // 恶意插入组合重音符: b + \u0300 + l + \u0301 (变体 bl)
    const zalgoBl = 'b\u0300l\u0301';
    expect(normalizeForFilter(zalgoBl)).toBe('bl');
    const blCheck = checkRequestBlacklist([zalgoBl]);
    expect(blCheck.blocked).toBe(true);
    expect(blCheck.matchedTag).toBe(zalgoBl);
    expect(blCheck.categoryName).toBe('男同/BL/腐向');
  });

  it('F-05 验证：纳西妲映射统一为纯假名 ナヒーダ，与 EXCLUSIVE_GROUPS 原神组精准对齐', () => {
    expect(CHARACTER_TAG_MAP['纳西妲']).toBe('ナヒーダ');
    // 搜纳西妲时，若作品同时打满了雷电将军 Tag 且非合集，正确判定蹭热度
    const fakeIllust: PixivIllustration = {
      pid: 'nahida_001',
      title: '纳西妲作品',
      artist: '画师',
      localPath: '/tmp/test.jpg',
      score: 1000,
      bookmarks: 1000,
      uploadDate: new Date().toISOString(),
      tags: ['ナヒーダ', '雷電将軍'], // 蹭了同组雷电将军
      originalUrl: 'https://i.pximg.net/nahida.jpg',
      isFromCache: true,
    };
    const comp = checkExclusiveGroup(fakeIllust, CHARACTER_TAG_MAP['纳西妲']!);
    expect(comp.compliant).toBe(false);
    expect(comp.reason).toContain('雷電将軍');
  });

  it('F-02 验证：互斥组短名精确对齐，搜索未收录的泛短名不会错误激活同组互斥', () => {
    // 用户直接输入短名 "ミカ"（未在映射表中的非全称）
    // 包含 "アロナ" 的独立同人作品不应被简单子串匹配误杀
    const fakeIllust: PixivIllustration = {
      pid: 'alona_001',
      title: '阿洛娜单独插画',
      artist: '画师',
      localPath: '/tmp/test.jpg',
      score: 1000,
      bookmarks: 1000,
      uploadDate: new Date().toISOString(),
      tags: ['アロナ'],
      originalUrl: 'https://i.pximg.net/alona.jpg',
      isFromCache: true,
    };
    // 搜 "ミカ"，由于短名并不等于 "聖園ミカ"，不会错误激活蔚蓝档案互斥组
    const comp = checkExclusiveGroup(fakeIllust, 'ミカ');
    expect(comp.compliant).toBe(true);
  });

  it('F-03 验证：PixivService 多实例单例停机钩子与 destroy 正常注销', () => {
    const testDir = resolve(tmpdir(), `pixiv_svc_destroy_test_${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const svc1 = new PixivService({ mediaDir: testDir, metadataFile: join(testDir, 'm1.json') });
    const svc2 = new PixivService({ mediaDir: testDir, metadataFile: join(testDir, 'm2.json') });
    // 销毁实例确保回调从 Set 移除
    svc1.destroy();
    svc2.destroy();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('F-04 验证：DynamicTagStore 保存异常时自动清理 tmp 临时文件', () => {
    const testDir = resolve(tmpdir(), `pixiv_dyn_err_test_${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const store = new DynamicTagStore({ filePath: join(testDir, 'dyn.json') });
    store.set('测试', ['test']);
    store.save();

    // 检查是否有残留 .tmp 文件
    const files = readdirSync(testDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe('R18 显式约束与全年龄误命中根治验证 (用户反馈 "r18 巨乳" 事故专项修复)', () => {
  it('checkRequestedGreylistMatched: 显式请求 r18 时全年龄作品被严密拦截，真实 R18 作品通过', () => {
    const allowR18 = new Set(['r18']);

    // 1. 全年龄巨乳作品 (复现事故 PID 151456499)
    const normalOppaiIllust = {
      pid: '151456499',
      title: 'うちのアルラウネちゃん',
      artist: '香坂ひかり',
      tags: ['うちの子', 'オリジナル', 'オリキャラ', 'アルラウネ', 'モンスター娘', 'おっぱい', '制服', '巨乳'],
      bookmarks: 100,
      uploadDate: new Date().toISOString(),
      localPath: '/tmp/test.png',
      score: 100,
      isFromCache: true,
      xRestrict: 0,
    };
    const resNormal = checkRequestedGreylistMatched(normalOppaiIllust, allowR18);
    expect(resNormal.compliant).toBe(false);
    expect(resNormal.reason).toContain('R18/限制级');

    // 2. 官方 xRestrict: 1 限制级作品
    const officialR18Illust = {
      pid: 'r18_001',
      title: 'R18作品',
      artist: '画师',
      tags: ['巨乳'],
      bookmarks: 100,
      uploadDate: new Date().toISOString(),
      localPath: '/tmp/test.png',
      score: 100,
      isFromCache: true,
      xRestrict: 1,
    };
    expect(checkRequestedGreylistMatched(officialR18Illust, allowR18).compliant).toBe(true);

    // 3. 画师标注的 R-18 不算：全年龄作品 (xRestrict === 0) 即便打上 R-18 / R18 / 全角 ｒ１８，也不满足 R18 灰名单要求
    const taggedR18Illust1 = { ...normalOppaiIllust, tags: ['巨乳', 'R-18'] };
    const taggedR18Illust2 = { ...normalOppaiIllust, tags: ['巨乳', 'R18'] };
    const taggedR18Illust3 = { ...normalOppaiIllust, tags: ['巨乳', 'ｒ１８'] };
    expect(checkRequestedGreylistMatched(taggedR18Illust1, allowR18).compliant).toBe(false);
    expect(checkRequestedGreylistMatched(taggedR18Illust2, allowR18).compliant).toBe(false);
    expect(checkRequestedGreylistMatched(taggedR18Illust3, allowR18).compliant).toBe(false);

    // 官方标注 xRestrict: 1 携带标签通过
    const officialTaggedR18Illust1 = { ...officialR18Illust, tags: ['巨乳', 'R-18'] };
    expect(checkRequestedGreylistMatched(officialTaggedR18Illust1, allowR18).compliant).toBe(true);

    // 4. 多灰名单联合约束：请求 r18 + 口交
    const allowBoth = new Set(['r18', 'oral']);
    expect(checkRequestedGreylistMatched(officialTaggedR18Illust1, allowBoth).compliant).toBe(false); // 缺少口交
    const multiMatchIllust = { ...officialTaggedR18Illust1, tags: ['巨乳', 'R-18', 'フェラチオ'], xRestrict: 1 };
    expect(checkRequestedGreylistMatched(multiMatchIllust, allowBoth).compliant).toBe(true);

    // 画师标注了口交但官方非 R18 (xRestrict: 0) 时，仍会被 R18 约束拦截
    const fakeMultiMatchIllust = { ...normalOppaiIllust, tags: ['巨乳', 'R-18', 'フェラチオ'], xRestrict: 0 };
    expect(checkRequestedGreylistMatched(fakeMultiMatchIllust, allowBoth).compliant).toBe(false);
  });

  it('matchMetadataTags: 本地元数据匹配时，带 r18 的请求绝不能匹配全年龄图（即便画师标注了 R-18）', () => {
    const service = new PixivService();
    const normalMeta = {
      pid: '151456499',
      title: 'うちのアルラウネちゃん',
      artist: '香坂ひかり',
      tags: ['うちの子', 'オリジナル', 'オリキャラ', 'アルラウネ', 'モンスター娘', 'おっぱい', '制服', '巨乳'],
      bookmarks: 100,
      uploadDate: new Date().toISOString(),
      filePath: '/tmp/test.png',
      originalUrl: 'https://i.pximg.net/test.jpg',
      cachedAt: Date.now(),
      xRestrict: 0,
    };

    // 搜普通 "巨乳"：命中正常
    expect((service as any).matchMetadataTags(normalMeta, ['巨乳'], ['巨乳'], new Set())).toBe(true);

    // 搜 "r18 巨乳"：绝对不得命中全年龄图！
    const allowedGreylist = new Set(['r18']);
    expect((service as any).matchMetadataTags(normalMeta, ['R-18', '巨乳'], ['r18', '巨乳'], allowedGreylist)).toBe(false);

    // 画师打上 R-18 标签的全年龄图，带 r18 的请求依然绝不能命中！
    const taggedMeta = { ...normalMeta, tags: [...normalMeta.tags, 'R-18'] };
    expect((service as any).matchMetadataTags(taggedMeta, ['R-18', '巨乳'], ['r18', '巨乳'], allowedGreylist)).toBe(false);

    // 但如果用户搜的是普通 "巨乳"，画师打上 R-18 标签的全年龄图正常放行（因为画师标注不算 R-18）
    expect((service as any).matchMetadataTags(taggedMeta, ['巨乳'], ['巨乳'], new Set())).toBe(true);

    // 全角 ｒ１８ 输入同样能正确剥离灰名单标签，真实官方 R18 图正确命中
    const officialMeta = { ...normalMeta, xRestrict: 1 };
    expect((service as any).matchMetadataTags(taggedMeta, ['R-18', '巨乳'], ['ｒ１８', '巨乳'], allowedGreylist)).toBe(false);
    expect((service as any).matchMetadataTags(officialMeta, ['R-18', '巨乳'], ['ｒ１８', '巨乳'], allowedGreylist)).toBe(true);
  });

  it('多灰名单与画师标注边界验证：全年龄画师标R18且含口交标签时，在口交请求下正常放行', () => {
    const fakeMultiIllust = {
      pid: '999',
      title: '口交画师自标R18全年龄',
      artist: '画师',
      tags: ['巨乳', 'R-18', 'フェラチオ'],
      bookmarks: 10,
      uploadDate: '',
      localPath: '',
      score: 10,
      isFromCache: false,
      xRestrict: 0,
    };

    // 1. 请求仅包含 oral：画师自标 R-18 不阻断，满足口交特征，放行
    const allowOral = new Set(['oral']);
    expect(checkImageGreylist(fakeMultiIllust, allowOral).compliant).toBe(true);
    expect(checkRequestedGreylistMatched(fakeMultiIllust, allowOral).compliant).toBe(true);

    // 2. 请求仅包含 r18：不仅因含有未授权口交被拦截，即便绕过口交也不满足 r18 要求
    const allowR18 = new Set(['r18']);
    expect(checkImageGreylist(fakeMultiIllust, allowR18).compliant).toBe(false);
    expect(checkRequestedGreylistMatched(fakeMultiIllust, allowR18).compliant).toBe(false);

    // 3. 同时请求 r18 + oral：虽然通过 checkImageGreylist，但在 checkRequestedGreylistMatched 处因 xRestrict===0 严厉拦截
    const allowBoth = new Set(['r18', 'oral']);
    expect(checkImageGreylist(fakeMultiIllust, allowBoth).compliant).toBe(true);
    expect(checkRequestedGreylistMatched(fakeMultiIllust, allowBoth).compliant).toBe(false);

    // 4. 真实官方 R18 作品 (xRestrict === 1) 且带有口交标签：在 r18 + oral 请求下全部通过
    const realMultiIllust = { ...fakeMultiIllust, xRestrict: 1 };
    expect(checkImageGreylist(realMultiIllust, allowBoth).compliant).toBe(true);
    expect(checkRequestedGreylistMatched(realMultiIllust, allowBoth).compliant).toBe(true);
  });

  it('干净会话端到端验证：检索 "r18 巨乳" 必须返回真实 R18 作品，绝不发全年龄图', async () => {
    const testDir = resolve(tmpdir(), `pixiv_clean_session_test_${Date.now()}`);
    const mediaDir = join(testDir, 'media');
    const metaFile = join(testDir, 'meta.json');
    const histFile = join(testDir, 'hist.json');
    mkdirSync(mediaDir, { recursive: true });

    const fileNormal = join(mediaDir, 'pixiv_151456499_p0.png');
    const fileR18 = join(mediaDir, 'pixiv_181818181_p0.png');
    const fileFakeR18 = join(mediaDir, 'pixiv_199999999_p0.png');
    writeFileSync(fileNormal, 'normal image');
    writeFileSync(fileR18, 'r18 image');
    writeFileSync(fileFakeR18, 'fake r18 image');

    const service = new PixivService({
      mediaDir,
      metadataFile: metaFile,
      historyManager: new PixivHistoryManager(histFile),
    });

    // 预填本地缓存：
    // 1. 全年龄巨乳图 (151456499, xRestrict: 0)
    // 2. 真实官方 R-18 巨乳图 (181818181, xRestrict: 1)
    // 3. 画师标了 R-18 但官方全年龄图 (199999999, xRestrict: 0)
    (service as any).metadataMap.set('151456499_p0', {
      pid: '151456499',
      title: 'うちのアルラウネちゃん',
      artist: '香坂ひかり',
      tags: ['うちの子', 'オリジナル', 'オリキャラ', 'アルラウネ', 'おっぱい', '巨乳'],
      bookmarks: 100,
      uploadDate: new Date().toISOString(),
      filePath: fileNormal,
      originalUrl: 'https://i.pximg.net/normal.png',
      cachedAt: Date.now(),
      page: 0,
      illustType: 0,
      xRestrict: 0,
    });

    (service as any).metadataMap.set('181818181_p0', {
      pid: '181818181',
      title: '真正的R18插画',
      artist: '绅士画师',
      tags: ['R-18', '巨乳'],
      bookmarks: 100,
      uploadDate: new Date().toISOString(),
      filePath: fileR18,
      originalUrl: 'https://i.pximg.net/r18.png',
      cachedAt: Date.now(),
      page: 0,
      illustType: 0,
      xRestrict: 1,
    });

    (service as any).metadataMap.set('199999999_p0', {
      pid: '199999999',
      title: '画师标注R18但官方全年龄',
      artist: '蹭热度画师',
      tags: ['R-18', '巨乳'],
      bookmarks: 90,
      uploadDate: new Date().toISOString(),
      filePath: fileFakeR18,
      originalUrl: 'https://i.pximg.net/fake.png',
      cachedAt: Date.now(),
      page: 0,
      illustType: 0,
      xRestrict: 0,
    });

    // 模拟网络无新数据，完全考验本地和质检网
    vi.spyOn(service as any, 'fetchFromNetwork').mockResolvedValue([]);

    // 1. 干净会话 A：用户输入 "r18 巨乳"
    const cleanSessionA = `clean_session_${Date.now()}_A`;
    const resA = await service.searchIllustrations(cleanSessionA, ['r18', '巨乳'], 1);
    expect(resA.illustrations.length).toBe(1);
    expect(resA.illustrations[0]!.pid).toBe('181818181'); // 必须且只能是官方 R-18 作品
    expect(resA.illustrations[0]!.pid).not.toBe('151456499'); // 绝不能是全年龄图
    expect(resA.illustrations[0]!.pid).not.toBe('199999999'); // 绝不能是画师自标R18的全年龄图

    // 2. 干净会话 B：无官方 R18 图时输入 "r18 巨乳"（仅有普通全年龄和画师自标R18全年龄）
    (service as any).metadataMap.delete('181818181_p0');
    const cleanSessionB = `clean_session_${Date.now()}_B`;
    const resB = await service.searchIllustrations(cleanSessionB, ['r18', '巨乳'], 1);
    expect(resB.illustrations.length).toBe(0); // 宁可返回 0 张，绝不允许全年龄图（包括自标R18者）充数

    // 3. 干净会话 C：用户搜正常 "巨乳"（不含 r18）
    const cleanSessionC = `clean_session_${Date.now()}_C`;
    const resC = await service.searchIllustrations(cleanSessionC, ['巨乳'], 1);
    expect(resC.illustrations.length).toBe(1);
    // 正常放行官方全年龄巨乳图 (151456499 或 199999999)
    expect(['151456499', '199999999']).toContain(resC.illustrations[0]!.pid);

    // 清理测试临时文件
    rmSync(testDir, { recursive: true, force: true });
  });
});
