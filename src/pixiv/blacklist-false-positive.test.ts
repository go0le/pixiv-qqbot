import { describe, expect, it } from 'vitest';
import { checkImageBlacklist, checkRequestBlacklist } from './filter.ts';
const m = (tags: string[], title = '') => ({ pid: '1', title, artist: 'a', tags, xRestrict: 0, illustType: 0, aiType: 1 }) as any;
describe('blacklist short-keyword false positives', () => {
  for (const t of ['blonde', 'BlueArchive', 'ブルーアーカイブ', 'table', 'グロス', '豆腐']) {
    it(`tag ${t} passes`, () => expect(checkImageBlacklist(m([t])).compliant).toBe(true));
    it(`request ${t} passes`, () => expect(checkRequestBlacklist([t]).blocked).toBe(false));
  }
  it('title "Blue table" passes', () => expect(checkImageBlacklist(m([], 'Blue table')).compliant).toBe(true));
  for (const t of ['BL', 'bl', 'ＢＬ', 'BL松', 'ボーイズラブ', '腐向け', '腐', 'グロ', 'グロ注意', 'yaoi']) {
    it(`tag ${t} blocked`, () => expect(checkImageBlacklist(m([t])).compliant).toBe(false));
    it(`request ${t} blocked`, () => expect(checkRequestBlacklist([t]).blocked).toBe(true));
  }
  it('title "BL / 創作" blocked', () => expect(checkImageBlacklist(m([], 'BL / 創作')).compliant).toBe(false));
});
