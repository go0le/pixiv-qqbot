/**
 * LLM 语义标签提取与翻译器 (AI 语义理解层)
 *
 * 当用户输入的搜索词或自然语言短语未在静态/动态映射表中收录时，
 * 调用大模型（如 Antigravity CLI / agy）对用户的描述进行语义分析，
 * 提炼角色特征、服装属性、风格氛围，并跨语言对齐为 Pixiv 平台上标准、高命中率的日文/常用标签。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export class LlmTagResolver {
  private readonly agyPath: string;
  private readonly timeoutMs: number;
  private readonly customExecutor?: (prompt: string) => Promise<string>;

  public constructor(options: LlmTagResolverOptions = {}) {
    this.agyPath = resolveAgyBinary(options.agyPath);
    this.timeoutMs = options.timeoutMs ?? 18000;
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
      '1. 过滤“想要”、“来一张”、“高清”、“壁纸”、“看”、“有无”等与图像特征无关的口语虚词。',
      '2. 将每个中文特征词转换为 Pixiv 最常用的日文标签（如“水手服”->“セーラー服”，“大姐姐”->“お姉さん”，“双马尾”->“ツインテール”）。专有名词或常用英文可保留（如“JK”, “original”）。',
      '3. 将输出严格限制为合法 JSON 格式，不要输出任何额外的 Markdown 说明或代码块外的闲聊：',
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
  private async executePrompt(prompt: string): Promise<string> {
    if (this.customExecutor) {
      return this.customExecutor(prompt);
    }

    return new Promise<string>((resolve, reject) => {
      const args = [
        '-p',
        prompt,
        '--dangerously-skip-permissions',
      ];

      const child = spawn(this.agyPath, args, {
        env: { ...process.env },
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
