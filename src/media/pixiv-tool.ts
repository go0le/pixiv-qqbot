/**
 * 内置 qqbot_pixiv_search 工具 — 检索并投递 Pixiv 高质量插画
 *
 * 供自然语言对话场景下的 Agent 意图识别调用（例如“帮我找一张信浓壁纸”、“来两张爱丽丝的图”）。
 * 自动应用 1 年半衰期时效性加权、分会话去重与 15 秒冷却。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImQQBotConfig } from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { checkRequestBlacklist, defaultPixivService } from '../pixiv/index.ts';
import type { MediaSenderLike } from './send-media.ts';

export const PIXIV_TOOL_NAME = 'qqbot_pixiv_search';

const DESCRIPTION =
  'Search high-quality Pixiv anime illustration images by character name or tag. '
  + 'Automatically applies a 1-year half-life popularity ranking, per-chat deduplication, '
  + 'and downloads original image quality. Returns image local paths and artist names. '
  + 'Optionally automatically sends the images to the current QQ conversation.';

interface PixivToolArgs {
  keyword: string;
  count?: number;
  auto_send?: boolean;
}

export function registerPixivTool(
  ctx: Context,
  bot: MediaSenderLike,
  manager: SessionManager,
  _config: ImQQBotConfig,
  logger: Logger,
): void {
  const tools = ctx.get('tools') as { register?: (def: unknown) => unknown } | undefined;
  if (!tools?.register) {
    logger.warn('im-qqbot: tools 服务不可用，qqbot_pixiv_search 工具未注册');
    return;
  }

  const definition = {
    name: PIXIV_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Character name or tag (e.g. "信浓", "爱丽丝", "流萤", "原神").',
        },
        count: {
          type: 'integer',
          description: 'Number of images to fetch (1 to 3, default 1).',
        },
        auto_send: {
          type: 'boolean',
          description: 'Whether to automatically send the images to the user/group (default true).',
        },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          foundCount: { type: 'integer' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pid: { type: 'string' },
                title: { type: 'string' },
                artist: { type: 'string' },
                localPath: { type: 'string' },
              },
            },
          },
          cooldownSec: { type: 'integer' },
          exhaustedReset: { type: 'boolean' },
        },
        required: ['tag', 'foundCount', 'images'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const v = value as { tag: string; foundCount: number };
        return [{ type: 'text', text: `已检索到 ${v.foundCount} 张关于「${v.tag}」的 Pixiv 插画` }];
      },
    },
    async execute(
      args: unknown,
      exec: { signal: AbortSignal; agent?: unknown },
    ): Promise<Record<string, unknown>> {
      const { keyword, count = 1, auto_send = true } = args as PixivToolArgs;
      if (!keyword || typeof keyword !== 'string') {
        throw new Error('qqbot_pixiv_search: `keyword` must be a non-empty string');
      }

      // 定位当前会话
      let replyTarget: ReplyTarget | undefined;
      const agent = exec.agent as DshAgent | undefined;
      if (agent) {
        const session = manager.findByAgent(agent);
        if (session) {
          replyTarget = session.replyTarget;
        }
      }

      const chatKey = replyTarget ? `${replyTarget.scope}:${replyTarget.targetId}` : 'global:default';

      // 0. 黑名单前置拦截（不扣除会话 CD - NF-09）
      const tokens = keyword.trim().split(/\s+/).filter(Boolean);
      const blCheck = checkRequestBlacklist(tokens);
      if (blCheck.blocked) {
        return {
          tag: keyword,
          foundCount: 0,
          images: [],
          blocked: true,
          message: `🚫 请求包含禁止标签「${blCheck.matchedTag}」（黑名单分类：${blCheck.categoryName}），系统拒绝检索。`,
        };
      }

      // 1. 检查 CD
      const cd = defaultPixivService.consumeCooldown(chatKey);
      if (!cd.allowed) {
        return {
          tag: keyword,
          foundCount: 0,
          images: [],
          cooldownSec: cd.remainingSec,
          message: `技能冷却中，请等待 ${cd.remainingSec} 秒后再试`,
        };
      }

      const searchCount = Math.max(1, Math.min(3, Number(count) || 1));
      const res = await defaultPixivService.searchIllustrations(chatKey, keyword, searchCount);

      if (res.blocked) {
        return {
          tag: keyword,
          foundCount: 0,
          images: [],
          blocked: true,
          message: res.blockReason || '请求包含禁止标签，已被拦截',
        };
      }

      if (res.illustrations.length === 0 && res.notice) {
        return {
          tag: res.tag || keyword,
          foundCount: 0,
          images: [],
          message: res.notice,
        };
      }

      if (auto_send && replyTarget && res.illustrations.length > 0) {
        let sentIdx = 0;
        for (const illust of res.illustrations) {
          if (illust.localPath) {
            try {
              if (sentIdx > 0) {
                await new Promise(r => setTimeout(r, 1500));
              }
              await bot.sendImage(replyTarget, { localPath: illust.localPath });
              const textSender = bot as unknown as { sendText?: (target: ReplyTarget, text: string) => Promise<unknown> };
              if (typeof textSender.sendText === 'function') {
                await textSender.sendText(replyTarget, `🎨 画师：${illust.artist}`);
              }
              sentIdx++;
            } catch (err) {
              logger.warn(`im-qqbot: failed to auto-send pixiv image: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }

      return {
        tag: res.tag,
        foundCount: res.illustrations.length,
        images: res.illustrations.map(i => ({
          pid: i.pid,
          title: i.title,
          artist: i.artist,
          localPath: i.localPath,
        })),
        exhaustedReset: res.exhaustedReset ?? false,
      };
    },
  };

  tools.register(definition);
  logger.info(`im-qqbot: tool ${PIXIV_TOOL_NAME} registered`);
}
