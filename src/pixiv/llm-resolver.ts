/**
 * LLM 语义标签提取与翻译器 (AI 语义理解层)
 *
 * 当用户输入的搜索词或自然语言短语未在静态/动态映射表中收录时，
 * 调用大模型（如 Antigravity CLI / agy）对用户的描述进行语义分析，
 * 提炼角色特征、服装属性、风格氛围，并跨语言对齐为 Pixiv 平台上标准、高命中率的日文/常用标签。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AntigravityProcess } from '../antigravity/process.ts';
import os from 'node:os';
import path from 'node:path';

export interface LlmTagResolutionResult {
  /** 最终转换后的规范标签列表（去重） */
  tags: string[];
  /** 学习到的词组映射对（原始词 -> 对应 Pixiv 标签列表） */
  mappings: Record<string, string[]>;
}

export interface LlmTagResolverOptions {
  agyPath?: string;
  timeoutMs?: number;
  /** 自定义 LLM 执行器，便于单元测试或切换底层 Provider */
  customExecutor?: (prompt: string) => Promise<string>;
}

export function resolveAgyBinary(customPath?: string): string {
  if (customPath) return customPath;
  if (process.env.AGY_PATH) return process.env.AGY_PATH;
  const homeAgy = path.join(os.homedir(), '.local/bin/agy');
  if (existsSync(homeAgy)) return homeAgy;
  return 'agy';
}

/**
 * 标签纠错用的 agy 跑在一个受限、无密钥的环境里（上一轮审查 S2）：
 * 它只需要模型吐一行 JSON，不需要任何工具，也不该拿到 PIXIV_REFRESH_TOKEN / QQBOT_SECRET 等密钥。
 * - 专用 HOME（~/.hagemi-resolver，由 setup-guest-home.py 生成，settings 拒绝一切工具、无 MCP）；
 * - 不带 --dangerously-skip-permissions（无头模式下未授权工具一律自动拒绝）；
 * - 只透传最小环境变量，绝不整份继承 process.env。
 */
export const RESOLVER_HOME = process.env.PIXIV_LLM_HOME || path.join(os.homedir(), '.hagemi-resolver');
export const RESOLVER_CWD = process.env.PIXIV_LLM_CWD || path.join(RESOLVER_HOME, 'sandbox');

export function resolverEnv(): Record<string, string> {
  const e: Record<string, string> = {
    HOME: RESOLVER_HOME,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
  };
  if (process.env.LC_ALL) e.LC_ALL = process.env.LC_ALL;
  if (process.env.TERM) e.TERM = process.env.TERM;
  return e;
}

export class LlmTagResolver {
  private readonly agyPath: string;
  private readonly timeoutMs: number;
  private readonly customExecutor?: (prompt: string) => Promise<string>;

  public constructor(options: LlmTagResolverOptions = {}) {
    this.agyPath = resolveAgyBinary(options.agyPath);
    this.timeoutMs = Math.max(options.timeoutMs ?? 18000, Number(process.env.PIXIV_LLM_TIMEOUT_MS || 60000));
    this.customExecutor = options.customExecutor;
  }

  /**
   * 构建提炼 Pixiv 标签的专业 System/User Prompt
   */
  public buildPrompt(unmappedTokens: string[], fullInput?: string): string {
    const targetDesc = fullInput || unmappedTokens.join(' ');
    return [
      '你是一个二次元动漫与 Pixiv 插画标签专家。',
      '用户的自然语言搜索词在本地映射表中未命中，请对输入内容进行语义理解，提取角色、外貌、服装、属性、风格等核心概念，并翻译对齐为 Pixiv 平台最通用、高命中率的日文或常用官方检索标签。',
      '',
      `用户输入：${targetDesc}`,
      `未映射分词：${unmappedTokens.join(', ')}`,
      '',
      '【处理规范】',
      '如果某个词是黑名单类内容（BL/腐向、猎奇/血腥、福瑞/兽人、AI生成、草稿涂鸦等）的同义词、谐音、错别字或变体，必须如实翻译为对应的规范标签（如 BL、腐向け、グロ、ケモノ、獣人、AI生成），绝不能改写成中性词回避。',
      '最多输出 3 个最核心的标签（角色名放最前；同时给出作品名时角色标签用 Pixiv 规范的「角色名(作品名)」形式即可，不必再单独加作品名）。主观形容词与画质词（帅气、冷艳、可爱、阳光、高清、4k、好看）不要输出。熟悉中文圈外号：如 煮饭婆=雷電将軍(原神)、帝君/岩王爷=鍾離(原神)、金闪闪=ギルガメッシュ(Fate)、银老板=シルバーアッシュ(アークナイツ)、呆毛王=アルトリア・ペンドラゴン。',
      '1. 过滤“想要”、“来一张”、“高清”、“壁纸”、“看”、“有无”等与图像特征无关的口语虚词。',
      '2. 将每个中文特征词转换为 Pixiv 最常用的日文标签（如“水手服”->“セーラー服”，“大姐姐”->“お姉さん”，“双马尾”->“ツインテール”）。专有名词或常用英文可保留（如“JK”, “original”）。',
      '3. 角色名/专有名词不要自行换成另一个字（例：祀不要改成祭）；不确定就保留原词。\n4. 将输出严格限制为合法 JSON 格式，不要输出任何额外的 Markdown 说明或代码块外的闲聊：',
      '{',
      '  "tags": ["标签1", "标签2"],',
      '  "mappings": {',
      '    "原始词1": ["标签1"],',
      '    "原始词2": ["标签2"]',
      '  }',
      '}',
    ].join('\n');
  }

  /**
   * 执行 LLM 调用
   */
  private warmProc: AntigravityProcess | null = null;
  private warmCalls = 0;
  private warmQueue: Promise<unknown> = Promise.resolve();
  private warmDisabledUntil = 0;

  private newWarmProc(): AntigravityProcess {
    const cwd = RESOLVER_CWD;
    try { mkdirSync(cwd, { recursive: true }); } catch { /* ignore */ }
    const p = new AntigravityProcess(randomUUID(), {
      agyPath: this.agyPath,
      cwd,
      // 受限：不跳过权限确认，且用最小环境变量整份替换，不继承密钥（S2）
      dangerouslySkipPermissions: false,
      replaceEnv: resolverEnv(),
      turnTimeoutMs: this.timeoutMs,
      idleTimeoutMs: 0,
      extraArgs: ['--model', process.env.PIXIV_LLM_MODEL || 'gemini-3.8-flash-low'],
    });
    p.on('error', () => { /* handled per turn */ });
    return p;
  }

  /** 启动常驻 agy 并预热（PIXIV_LLM_TAGS=1 时在启动时调用） */
  public warmUp(): Promise<void> {
    if (this.customExecutor || process.env.PIXIV_LLM_TAGS !== '1' || process.env.PIXIV_LLM_WARM === '0') return Promise.resolve();
    const t0 = Date.now();
    return this.runWarm('只回复 JSON：{"tags":[],"mappings":{}}')
      .then(() => console.log(`[LlmTagResolver] warm agy ready in ${Date.now() - t0}ms`))
      .catch(err => console.warn('[LlmTagResolver] warm-up failed:', err));
  }

  private runWarm(prompt: string): Promise<string> {
    const job = this.warmQueue.then(async () => {
      const maxCalls = Number(process.env.PIXIV_LLM_RESET_EVERY || 30);
      if (this.warmProc && (!this.warmProc.isRunning || this.warmCalls >= maxCalls)) {
        if (this.warmProc.isRunning) await this.warmProc.terminate().catch(() => {});
        this.warmProc = null;
      }
      if (!this.warmProc) {
        this.warmProc = this.newWarmProc();
        this.warmCalls = 0;
      }
      const proc = this.warmProc;
      this.warmCalls++;
      let timer: NodeJS.Timeout | undefined;
      try {
        const res = await Promise.race([
          proc.sendUserMessage(prompt),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`warm agy timeout after ${this.timeoutMs}ms`)), this.timeoutMs); }),
        ]);
        return String((res as { response?: string }).response ?? '').trim();
      } catch (err) {
        await proc.terminate().catch(() => {});
        if (this.warmProc === proc) this.warmProc = null;
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.warmQueue = job.catch(() => {});
    return job;
  }

  private async executePrompt(prompt: string): Promise<string> {
    if (this.customExecutor) {
      return this.customExecutor(prompt);
    }
    if (process.env.PIXIV_LLM_WARM !== '0' && Date.now() >= this.warmDisabledUntil) {
      try {
        const out = await this.runWarm(prompt);
        if (out) return out;
        throw new Error('empty response from warm agy');
      } catch (err) {
        console.warn('[LlmTagResolver] warm agy failed, falling back to spawn:', err);
        this.warmDisabledUntil = Date.now() + 60000;
      }
    }
    return this.executePromptSpawn(prompt);
  }

  private async executePromptSpawn(prompt: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = [
        '-p',
        prompt,
        '--model', process.env.PIXIV_LLM_MODEL || 'gemini-3.8-flash-low',
      ];
      // 受限：不跳过权限确认（无头下未授权工具自动拒绝），用专用 HOME + 最小环境变量，不带密钥（S2）
      try { mkdirSync(RESOLVER_CWD, { recursive: true }); } catch { /* ignore */ }
      const child = spawn(this.agyPath, args, {
        cwd: RESOLVER_CWD,
        env: resolverEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error(`LlmTagResolver timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`agy exited with code ${code}: ${stderr || stdout}`));
        }
      });
    });
  }

  /**
   * 解析大模型输出的 JSON 结果
   */
  public parseLlmOutput(rawOutput: string): LlmTagResolutionResult | null {
    if (!rawOutput) return null;

    // 清除可能附带的 ```json ... ``` 标记
    let text = rawOutput.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }

    // 寻找最外层 JSON 结构
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (!parsed || typeof parsed !== 'object') return null;

      const tags: string[] = [];
      if (Array.isArray(parsed.tags)) {
        for (const t of parsed.tags) {
          if (typeof t === 'string' && t.trim()) {
            tags.push(t.trim());
          }
        }
      }

      const mappings: Record<string, string[]> = {};
      if (parsed.mappings && typeof parsed.mappings === 'object') {
        for (const [key, val] of Object.entries(parsed.mappings)) {
          if (typeof key === 'string' && key.trim()) {
            const list: string[] = [];
            if (Array.isArray(val)) {
              for (const v of val) {
                if (typeof v === 'string' && v.trim()) list.push(v.trim());
              }
            } else if (typeof val === 'string' && val.trim()) {
              list.push(val.trim());
            }
            if (list.length > 0) {
              mappings[key.trim()] = list;
              for (const item of list) {
                if (!tags.includes(item)) tags.push(item);
              }
            }
          }
        }
      }

      return {
        tags: Array.from(new Set(tags)),
        mappings,
      };
    } catch {
      return null;
    }
  }

  /** 0 结果纠错模式：对全部特征词做错别字/角色名/汉字纠正，返回 原词 -> 规范标签 */
  public async correct(tokens: string[], _fullInput?: string): Promise<LlmTagResolutionResult | null> {
    if (!tokens || tokens.length === 0) return null;
    if (!this.customExecutor && process.env.PIXIV_LLM_TAGS !== '1') return null;
    const prompt = [
      '任务：纠正 Pixiv 搜索标签。只输出一行 JSON，禁止任何解释、思考过程或 Markdown。',
      '规则：每个待检查词只纠正明显错别字/通俗外号对齐，输出 Pixiv 实际使用的规范标签（角色给官方日文名，如 涼花ひより→涼海ひより；中文特征词译成 Pixiv 常用日文标签）。绝不要把角色名改成另一个字/词（例：祀不要改成祭/祭り/巫女）；不确定就保留原词。删除数量词与口语虚词（来/张/帮我/的图片 等）。已正确的保持原样。',
      '如果某个词是黑名单类内容（BL/腐向、猎奇/血腥、福瑞/兽人、AI生成、草稿涂鸦等）的同义词、谐音、错别字或变体，必须如实翻译为对应的规范标签（如 BL、腐向け、グロ、ケモノ、獣人、AI生成），绝不能改写成中性词回避。',
      '最多输出 3 个最核心的标签（角色名放最前；同时给出作品名时角色标签用 Pixiv 规范的「角色名(作品名)」形式即可，不必再单独加作品名）。主观形容词与画质词（帅气、冷艳、可爱、阳光、高清、4k、好看）不要输出。熟悉中文圈外号：如 煮饭婆=雷電将軍(原神)、帝君/岩王爷=鍾離(原神)、金闪闪=ギルガメッシュ(Fate)、银老板=シルバーアッシュ(アークナイツ)、呆毛王=アルトリア・ペンドラゴン。',
      `待检查词：${tokens.join(', ')}`,
      '输出格式：{"tags":["标签"],"mappings":{"原词":["标签"]}}',
    ].join('\n');
    try {
      const raw = await this.executePrompt(prompt);
      return this.parseLlmOutput(raw);
    } catch (err) {
      console.warn('[LlmTagResolver] correction failed:', err);
      return null;
    }
  }

  /**
   * 解析未映射词组，返回对齐后的标签与映射对
   */
  public async resolve(unmappedTokens: string[], fullInput?: string): Promise<LlmTagResolutionResult | null> {
    if (!unmappedTokens || unmappedTokens.length === 0) {
      return null;
    }
    // 默认不拉起本机 agy。未映射的词原样当标签，避免每次搜索卡十几秒或误执行外部命令。
    if (!this.customExecutor && process.env.PIXIV_LLM_TAGS !== '1') {
      return null;
    }

    try {
      const prompt = this.buildPrompt(unmappedTokens, fullInput);
      const raw = await this.executePrompt(prompt);
      return this.parseLlmOutput(raw);
    } catch (err) {
      console.warn('[LlmTagResolver] Semantic tag resolution failed:', err);
      return null;
    }
  }
}
