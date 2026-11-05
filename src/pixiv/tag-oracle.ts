/**
 * Pixiv 侧标签事实源：自动补全 + 搜索命中校验。
 * LLM 只提候选；未经本模块确认的映射不得写入动态表、不得用于最终检索。
 */
import { buildIllustrationSearchUrl, extractSearchWorks, mapSearchWork } from "./parse.ts";
import type { SearchAuth } from "./auth.ts";
import { FEATURE_DICT, peelFeatureWords } from "./compound.ts";
import { WORK_NAME_PREFIXES } from "./constants.ts";

export interface PixivSuggest {
  name: string;
  translated_name?: string | null;
}

export interface TagOracleDeps {
  buildSearchAuth: () => Promise<SearchAuth>;
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

const CHAR_TAG_RE = /^.+\([^()]+\)$/;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[：]/g, ":").replace(/\s+/g, "");
}


function sameToken(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

function stripWorkPrefix(s: string): string {
  const lower = s.toLowerCase();
  for (const p of WORK_NAME_PREFIXES) {
    if (lower.startsWith(p.toLowerCase()) && s.length > p.length) return s.slice(p.length).trim();
  }
  return s;
}

function likelyCharacterToken(o: string): boolean {
  // 「碧蓝航线帝国」这类作品名+角色名粘连词，先剥掉作品名前缀，只看剩下的角色名部分
  const s = stripWorkPrefix(o.trim());
  if (!s) return false;
  if (/[:：\/]/.test(s)) return false;
  if (s.length > 8) return false;
  if (/方舟|终末|原神|崩坏|星穹|铁道|档案|航线|舰队|vocaloid|fate|东方|連鎖|戦記/i.test(s)) return false;
  return true;
}

function looksRelated(original: string, proposed: string): boolean {
  if (!original || !proposed) return false;
  if (sameToken(original, proposed)) return true;
  const o = original.trim();
  const p = proposed.trim();
  const m = p.match(/^(.+?)[（(]/);
  if (m && (m[1] === o || sameToken(m[1]!, o))) return true;
  if (p.includes(o) && (p.startsWith(o + "(") || p.startsWith(o + "（"))) return true;
  const strip = (s: string) => s.replace(/[（(][^）)]*[）)]/g, "");
  const a = strip(o);
  const b = strip(p);
  if (a.length >= 3 && a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    if (diff === 1) return true;
  }
  return false;
}

/** 三个缓存各自的容量上限，超过就整体清空（进程内缓存，量级很小） */
const CACHE_MAX_ENTRIES = 500;
function putCache<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= CACHE_MAX_ENTRIES) map.clear();
  map.set(key, value);
}

export class PixivTagOracle {
  private readonly acCache = new Map<string, PixivSuggest[]>();
  private readonly existsCache = new Map<string, boolean>();
  private readonly sampleCache = new Map<string, string[]>();
  /**
   * 网络类失败的累计次数。调用方在一段校验前后比较它：期间增加过，说明「校验不通过」可能只是网络故障，
   * 不能据此删除已学到的映射。失败结果也不进缓存，网络恢复后会重新校验。
   */
  public failures = 0;

  public constructor(private readonly deps: TagOracleDeps) {}

  public async autocomplete(word: string): Promise<PixivSuggest[]> {
    const key = word.trim();
    if (!key) return [];
    if (this.acCache.has(key)) return this.acCache.get(key)!;
    try {
      const auth = await this.deps.buildSearchAuth();
      const url = `https://app-api.pixiv.net/v2/search/autocomplete?word=${encodeURIComponent(key)}&filter=for_android`;
      // app-api 才有 autocomplete；网页态跳过
      if (!auth.appApi) {
        putCache(this.acCache, key, []);
        return [];
      }
      const json = await this.deps.fetchJson(url, auth.headers) as { tags?: Array<Record<string, unknown>> };
      const tags: PixivSuggest[] = [];
      for (const t of json?.tags || []) {
        const name = typeof t.name === "string" ? t.name.trim() : "";
        if (!name) continue;
        const translated = typeof t.translated_name === "string" ? t.translated_name : null;
        tags.push({ name, translated_name: translated });
      }
      putCache(this.acCache, key, tags);
      return tags;
    } catch (err) {
      console.warn("[PixivTagOracle] autocomplete failed:", err instanceof Error ? err.message : err);
      this.failures++;
      return [];
    }
  }

  /** 取搜索结果里出现的标签（去重，保序） */
  public async sampleTagsFromSearch(word: string, limit = 40): Promise<string[]> {
    const key = word.trim();
    if (!key) return [];
    if (this.sampleCache.has(key)) return this.sampleCache.get(key)!;
    try {
      const auth = await this.deps.buildSearchAuth();
      const url = buildIllustrationSearchUrl(key, {
        wantsR18: false,
        appApi: auth.appApi,
        proxyBaseUrl: auth.proxyBaseUrl,
      });
      const json = await this.deps.fetchJson(url, auth.headers);
      const rows = extractSearchWorks(json);
      const out: string[] = [];
      const seen = new Set<string>();
      for (const row of rows.slice(0, 12)) {
        const mapped = mapSearchWork(row, false);
        if (!mapped) continue;
        for (const t of mapped.tags) {
          if (!t || seen.has(t)) continue;
          seen.add(t);
          out.push(t);
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      putCache(this.sampleCache, key, out);
      return out;
    } catch (err) {
      console.warn("[PixivTagOracle] sampleTags failed:", err instanceof Error ? err.message : err);
      this.failures++;
      return [];
    }
  }

  /** 标签在 Pixiv 上真实存在：自动补全精确命中，或搜索结果里出现精确标签 */
  public async tagExists(tag: string): Promise<boolean> {
    const key = tag.trim();
    if (!key) return false;
    if (this.existsCache.has(key)) return this.existsCache.get(key)!;
    const f0 = this.failures;
    const ac = await this.autocomplete(key);
    if (ac.some(t => t.name === key)) {
      putCache(this.existsCache, key, true);
      return true;
    }
    // 单字/短词自动补全常不回自身，用搜索结果精确标签兜底
    const samples = await this.sampleTagsFromSearch(key);
    const ok = samples.includes(key);
    // 期间出现过网络失败时，「不存在」不可信，不缓存
    if (ok || this.failures === f0) putCache(this.existsCache, key, ok);
    return ok;
  }

  /**
   * 优先从 Pixiv 数据推导原词对应标签。
   * contextTokens：同一次请求里的其它词（作品名等），用于共现消歧。
   */
  public async deriveFromPixiv(original: string, contextTokens: string[] = []): Promise<string[]> {
    const o = original.trim();
    if (!o) return [];

    const ac = await this.autocomplete(o);
    const picked: string[] = [];
    const push = (name: string) => {
      if (!name || picked.includes(name)) return;
      picked.push(name);
    };

    // 1) 翻译名精确对齐（中文作品名 → 日文官方标签）
    for (const t of ac) {
      if (t.translated_name && sameToken(t.translated_name, o)) push(t.name);
    }
    // 2) 名称精确命中
    for (const t of ac) {
      if (t.name === o) push(t.name);
    }
    // 3) 名称以「原词(」开头的角色标签
    for (const t of ac) {
      if (t.name.startsWith(o + "(") || t.name.startsWith(o + "（")) push(t.name);
    }

    // 4) 搜索共现：原词单独搜 + 与上下文组合搜
    const queries = [o];
    const ctx = contextTokens.map(x => x.trim()).filter(x => x && x !== o);
    if (ctx.length > 0) {
      queries.push(`${ctx[0]} ${o}`, `${o} ${ctx[0]}`);
      if (ctx.length > 1) queries.push(`${ctx.join(" ")} ${o}`);
    }
    const freq = new Map<string, number>();
    let originalSeenAsTag = false;
    for (const q of queries.slice(0, 3)) {
      const samples = await this.sampleTagsFromSearch(q);
      if (samples.includes(o)) originalSeenAsTag = true;
      const hasOriginal = samples.includes(o);
      const hasCtx = ctx.some(c => samples.some(s => s === c || looksRelated(c, s) || s.includes(c.replace(/[:：]/g, ""))));
      for (const t of samples) {
        if (t === o) freq.set(t, (freq.get(t) || 0) + 5);
        // 与原词同现的角色标签（日文官方名可与中文原词字形不同）
        if (CHAR_TAG_RE.test(t) && likelyCharacterToken(o)) {
          if (looksRelated(o, t)) {
            let bonus = 6;
            if (hasCtx || ctx.some(c => t.includes("エンドフィールド") || t.includes(c.replace(/[:：]/g, "").slice(0, 2)))) bonus += 3;
            freq.set(t, (freq.get(t) || 0) + bonus);
          } else if (hasOriginal && (hasCtx || ctx.some(c => t.includes(c.replace(/[:：]/g, "").slice(0, 2))))) {
            freq.set(t, (freq.get(t) || 0) + 4);
          }
        }
        if (ctx.length && hasCtx && looksRelated(o, t)) freq.set(t, (freq.get(t) || 0) + 1);
      }
    }
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

    // 原词本身就是有效 Pixiv 标签时，保留原词（防止被 LLM 改成别的字）
    if (originalSeenAsTag || (await this.tagExists(o))) {
      push(o);
    }

    // 有与原词同现的角色标签：仅在形似或有上下文支持时优先返回，防止无关联角色抢占
    const charHit = likelyCharacterToken(o)
      ? ranked.find(t => CHAR_TAG_RE.test(t) && (freq.get(t) || 0) >= 4 && (looksRelated(o, t) || ctx.length > 0))
      : undefined;
    if (charHit) {
      return [charHit];
    }

    for (const t of ranked) {
      if (t === o || looksRelated(o, t)) push(t);
      if (picked.length >= (likelyCharacterToken(o) ? 2 : 1)) break;
    }
    if (!likelyCharacterToken(o) && picked.length > 1) {
      const preferred = picked.find(t => t === o) || picked[0]!;
      return [preferred];
    }
    return picked.slice(0, 2);
  }

  /**
   * 校验「原词 → 候选」：候选必须在 Pixiv 存在，且与原词有明确关联。
   */
  public async isValidMapping(original: string, proposed: string, contextTokens: string[] = []): Promise<boolean> {
    const o = original.trim();
    const p = proposed.trim();
    if (!o || !p) return false;
    if (sameToken(o, p)) return true;

    if (!(await this.tagExists(p))) return false;

    // 自动补全原词能直接给出该候选
    const ac = await this.autocomplete(o);
    if (ac.some(t => t.name === p)) return true;
    if (ac.some(t => t.name === p && t.translated_name && sameToken(t.translated_name, o))) return true;
    if (ac.some(t => t.translated_name && sameToken(t.translated_name, o) && t.name === p)) return true;

    // 搜索共现：原词（±上下文）结果里出现候选
        // work titles must not bind to character tags by co-occurrence alone
    if (!likelyCharacterToken(o) && CHAR_TAG_RE.test(p) && !looksRelated(o, p)) {
      return false;
    }

const queries = [o, p];
    if (contextTokens[0]) {
      queries.push(`${contextTokens[0]} ${o}`, `${o} ${contextTokens[0]}`);
    }
    for (const q of queries.slice(0, 3)) {
      const samples = await this.sampleTagsFromSearch(q);
      if (samples.includes(p) && (samples.includes(o) || looksRelated(o, p) || samples.some(t => looksRelated(o, t) && t === p))) {
        return true;
      }
      // 候选的搜索结果里，翻译/标签能回到原词
      if (q === p && (samples.includes(o) || samples.some(t => sameToken(t, o)))) return true;
    }

    // 明确相关的写法变体（含原词的角色标签）且存在
    if (looksRelated(o, p) && (p.includes("(") || p.includes("（") || p.includes(o))) return true;

    return false;
  }

  /**
   * 复合词的一对多映射校验：原词是「属性词 + 角色/未收录词」粘连（如 巨乳妃咲）时，
   * 映射结果里至少要有一个标签能通过「剩余部分」（妃咲）的校验，才放行其中的属性标签（巨乳）。
   * 只有属性标签而没有任何角色标签的映射（巨乳妃咲 → [巨乳]）不放行，否则会把角色悄悄丢掉并被持久化。
   */
  private async validateCompoundMapping(orig: string, tags: string[], contextTokens: string[]): Promise<string[]> {
    const peeled = peelFeatureWords(orig.trim());
    if (!peeled) return [];
    const ctx = [...contextTokens, ...peeled.features];
    const restTags: string[] = [];
    for (const t of tags) {
      if (peeled.features.some(f => FEATURE_DICT[f] === t || f === t)) continue;
      if (await this.isValidMapping(peeled.rest, t, ctx)) restTags.push(t);
    }
    if (restTags.length === 0) return [];
    const featureTags = tags.filter(t => peeled.features.some(f => FEATURE_DICT[f] === t || f === t));
    return [...restTags, ...featureTags];
  }

  /** 过滤 LLM mappings：不通过则回退原词 */
  public async filterMappings(
    mappings: Record<string, string[]>,
    contextTokens: string[] = [],
  ): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [orig, tags] of Object.entries(mappings)) {
      const kept: string[] = [];
      for (const t of tags || []) {
        if (await this.isValidMapping(orig, t, contextTokens)) kept.push(t);
      }
      if (kept.length === 0 && (tags || []).length > 1) {
        kept.push(...await this.validateCompoundMapping(orig, tags, contextTokens));
      }
      if (kept.length > 0) out[orig] = Array.from(new Set(kept));
      // 不通过则不写 mappings（调用方保留原词）
    }
    return out;
  }
}
