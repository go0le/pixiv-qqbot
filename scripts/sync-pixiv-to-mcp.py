#!/usr/bin/env python3
"""
把 dsh-qqbot/src/pixiv 的核心代码同步到 external/pixiv-mcp/src/core。

为什么要有这个脚本：两个包各有一份 Pixiv 核心，之前靠手工整文件覆盖同步，
结果把 MCP 专有的逻辑（PIXIV_MCP_HOME 路径、flush、getIllustDetail、下载信号量…）整个冲掉，源码都编译不过。
本脚本只做「qqbot 版 + MCP 专有改动」的确定性合并，可重复运行。

规则：
- 直接复制：compound / constants / tag-oracle / types / filter / auth / dynamic-store / parse
- history：复制 qqbot 版后，换成 PIXIV_MCP_HOME 路径并去掉导入即创建的单例
- service：复制 qqbot 版后，套用下面列出的 MCP 专有改动；getIllustDetail / 下载实现取自 MCP 现有的 service.ts
- 不同步（两边各自维护）：llm-resolver（MCP 走 OpenAI 兼容 HTTP，不依赖 agy）、limiter、mutex、index
- 同步后所有 console.log 改为 console.error（MCP 的 stdout 只能放协议/CLI 的 JSON）

用法：python3 scripts/sync-pixiv-to-mcp.py [--check]
  --check 只检查是否有差异，有则退出码 1，不写文件。
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
Q = ROOT / 'src' / 'pixiv'
M = Path('/home/MIKU/external/pixiv-mcp/src/core')

COPY = ['compound.ts', 'constants.ts', 'tag-oracle.ts', 'types.ts', 'filter.ts', 'auth.ts', 'dynamic-store.ts', 'parse.ts']

outputs: dict[Path, str] = {}


def read(p: Path) -> str:
    return p.read_text(encoding='utf8')


def sub(s: str, old: str, new: str, name: str) -> str:
    if old not in s:
        sys.exit(f'[sync] 找不到替换锚点：{name}\n  {old[:100]!r}')
    return s.replace(old, new, 1)


# ---------- 直接复制 ----------
for f in COPY:
    outputs[M / f] = read(Q / f)

# ---------- history ----------
h = read(Q / 'history.ts')
h = sub(h, "  : resolve(homedir(), '.dsh-qqbot', 'pixiv_history.json');",
        "  : resolve(process.env.PIXIV_MCP_HOME ? resolve(process.env.PIXIV_MCP_HOME) : resolve(homedir(), '.pixiv-mcp'), 'pixiv_history.json');",
        'history path')
h = sub(h, "\n/** 全局单例历史记录器 */\nexport const defaultPixivHistory = new PixivHistoryManager();\n", "\n", 'history singleton')
outputs[M / 'history.ts'] = h

# ---------- service ----------
cur = read(M / 'service.ts')  # MCP 现有版本：取其中的 MCP 专有代码块
a = cur.index('  /**\n   * 读取单个作品详情')
b = cur.index('  /**\n   * 带防盗链 Referer 下载原图')
detail_block = cur[a:b]
a = cur.index('  public async downloadOriginalImage(')
b = cur.index('/** 体型/特征词') if '/** 体型/特征词' in cur else cur.index('const FLAT_RE')
download_block = cur[a:b]

s = read(Q / 'service.ts')
s = sub(s, "import { resolve, join } from 'node:path';\nimport { homedir } from 'node:os';\n",
        "import { createWriteStream, openSync, readSync, closeSync } from 'node:fs';\nimport { Readable, Transform } from 'node:stream';\nimport { pipeline } from 'node:stream/promises';\nimport { resolve, join } from 'node:path';\nimport { Semaphore } from './mutex.ts';\nimport { homedir } from 'node:os';\n", 'imports node')
s = sub(s, "import { PixivHistoryManager, defaultPixivHistory } from './history.ts';\nimport { PixivRateLimiter, defaultPixivLimiter } from './limiter.ts';",
        "import { PixivHistoryManager } from './history.ts';\nimport { PixivRateLimiter, cooldownFromEnv } from './limiter.ts';", 'imports history')
s = sub(s, "  normalizeForFilter,\n} from './filter.ts';", "  normalizeForFilter,\n  checkImageBlacklist,\n  checkImageGreylist,\n} from './filter.ts';", 'imports filter')
s = sub(s, "import { buildIllustrationSearchUrl, extractSearchWorks, mapSearchWork } from './parse.ts';",
        "import { buildIllustrationSearchUrl, extractSearchWorks, mapSearchWork, readIllustType } from './parse.ts';", 'imports parse')
s = sub(s, "/** 富媒体缓存目录 */\nexport const PIXIV_MEDIA_DIR = resolve(homedir(), '.dsh-qqbot', 'media');",
        "/** 数据根目录：PIXIV_MCP_HOME，默认 ~/.pixiv-mcp */\nexport const PIXIV_HOME = process.env.PIXIV_MCP_HOME\n  ? resolve(process.env.PIXIV_MCP_HOME)\n  : resolve(homedir(), '.pixiv-mcp');\n/** 图片目录：PIXIV_MEDIA_DIR，默认 $PIXIV_MCP_HOME/media */\nexport const PIXIV_MEDIA_DIR = process.env.PIXIV_MEDIA_DIR\n  ? resolve(process.env.PIXIV_MEDIA_DIR)\n  : resolve(PIXIV_HOME, 'media');", 'paths media')
s = sub(s, "resolve(homedir(), '.dsh-qqbot', 'pixiv_metadata.json')", "resolve(PIXIV_HOME, 'pixiv_metadata.json')", 'paths meta')
s = sub(s, "resolve(homedir(), '.dsh-qqbot', 'pixiv_dynamic_tags.json')", "resolve(PIXIV_HOME, 'pixiv_dynamic_tags.json')", 'paths dyn')
s = sub(s, "/** 半衰期常量: λ = ln(2) / 365 */",
        "/** 全局下载并发上限：PIXIV_DOWNLOAD_CONCURRENCY，默认 2 */\nconst downloadSemaphore = new Semaphore(Math.max(1, Number(process.env.PIXIV_DOWNLOAD_CONCURRENCY) || 2));\n\n/** 半衰期常量: λ = ln(2) / 365 */", 'semaphore')
s = sub(s, "  dynamicTagFile?: string;\n  dynamicTagStore?", "  dynamicTagFile?: string;\n  historyFile?: string;\n  dynamicTagStore?", 'config historyFile')
s = sub(s, "    this.history = config.historyManager || defaultPixivHistory;\n    this.limiter = config.rateLimiter || defaultPixivLimiter;\n    this.timeoutMs = config.timeoutMs ?? 15000;",
        "    this.history = config.historyManager || new PixivHistoryManager(config.historyFile);\n    this.limiter = config.rateLimiter || new PixivRateLimiter(cooldownFromEnv());\n    this.timeoutMs = config.timeoutMs ?? (Number(process.env.PIXIV_TIMEOUT_MS) > 0 ? Number(process.env.PIXIV_TIMEOUT_MS) : 15000);", 'ctor')
s = sub(s, "  public get dynamicTags(): DynamicTagStore {",
        "  /** 立即把历史、元数据、动态标签表落盘（CLI 退出前调用） */\n  public flush(): void {\n    this.cleanupFn();\n  }\n\n  public get dynamicTags(): DynamicTagStore {", 'flush')
s = sub(s, "public evictOldCache(maxBytes = 2 * 1024 * 1024 * 1024): void {",
        "public evictOldCache(maxBytes = (Number(process.env.PIXIV_CACHE_MAX_MB) > 0 ? Number(process.env.PIXIV_CACHE_MAX_MB) : 512) * 1024 * 1024): void {", 'evict')
s = sub(s, "    const now = Date.now();\n    const isCircuitBroken = now < this.circuitBreakUntil;\n",
        "    const now = Date.now();\n    const isCircuitBroken = now < this.circuitBreakUntil;\n    let networkError: string | undefined = isCircuitBroken\n      ? `Pixiv 连续请求失败，已暂停联网 ${Math.ceil((this.circuitBreakUntil - now) / 1000)} 秒`\n      : undefined;\n", 'networkError decl')
s = sub(s, "      } catch {\n        this.consecutiveFailures += 1;",
        "      } catch (err) {\n        networkError = `Pixiv 请求失败：${err instanceof Error ? err.message : String(err)}`;\n        this.consecutiveFailures += 1;", 'networkError set')
s = sub(s, "...this.authNotice(0, allowedGreylist),", "...this.authNotice(0, allowedGreylist, networkError),", 'authNotice0')
s = sub(s, "...this.authNotice(finalized.length, allowedGreylist),", "...this.authNotice(finalized.length, allowedGreylist, networkError),", 'authNotice1')
s = sub(s, "  private authNotice(found: number, allowedGreylist: Set<string>): { notice?: string } {\n",
        "  private authNotice(found: number, allowedGreylist: Set<string>, networkError?: string): { notice?: string } {\n    if (found === 0 && networkError) return { notice: networkError };\n", 'authNotice def')
s = sub(s, '  /**\n   * 带防盗链 Referer 下载原图', detail_block + '  /**\n   * 带防盗链 Referer 下载原图', 'detail block')
a2 = s.index('  public async downloadOriginalImage(')
b2 = s.index('/** 体型/特征词') if '/** 体型/特征词' in s else s.index('const FLAT_RE')
s = s[:a2] + download_block + s[b2:]
s = sub(s, "export const defaultPixivService = new PixivService();",
        "let defaultInstance: PixivService | undefined;\n/** 懒加载的全局单例（导入时不创建目录、不读盘） */\nexport function getDefaultPixivService(): PixivService {\n  if (!defaultInstance) defaultInstance = new PixivService();\n  return defaultInstance;\n}", 'singleton')
outputs[M / 'service.ts'] = s

# stdout 留给协议：core 里所有 console.log → console.error
for p, text in list(outputs.items()):
    outputs[p] = text.replace('console.log(', 'console.error(')

# ---------- 写出 / 检查 ----------
changed = [p for p, t in outputs.items() if not p.exists() or read(p) != t]
if '--check' in sys.argv:
    for p in changed:
        print('differs:', p)
    sys.exit(1 if changed else 0)
for p in changed:
    p.write_text(outputs[p], encoding='utf8')
    print('updated:', p)
print('done' if changed else 'already in sync')
