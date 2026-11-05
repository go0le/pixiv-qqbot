/**
 * Antigravity QQBot Runner
 *
 * Connects incoming QQ messages directly to Google Antigravity CLI,
 * with real-time stream chunking for private chats, chunked Markdown for group chats,
 * session isolation per peer, and command handling (/help, /clear, /status, /ping).
 */
import {
  QQBot,
  errorHandler,
  messageFilter,
  mentionGate,
  quoteRef,
  type MiddlewareContext,
  type QQBotInboundMessage,
  type ReplyTarget,
} from '@tencent-connect/qqbot-nodejs';
import { AntigravitySessionManager } from './session-manager.ts';
import { resolveCredentials } from './auth.ts';
import {
  downloadImageAttachments,
  buildPromptWithMedia,
  extractOutboundMedia,
  type InboundAttachment,
  type DownloadedMedia,
} from './media.ts';
import { sendMediaFile } from '../media/send-media.ts';
import { chunkMarkdownText } from '../transport/chunker.ts';
import { ReplyLimiter } from '../transport/reply-limiter.ts';
import { defaultPixivService, parseNaturalPixivQuery } from '../pixiv/index.ts';

import { looksLikePixivImageAsk } from './image-intent.ts';

import type { AntigravityBotConfig } from './types.ts';

export class AntigravityQQBot {
  private readonly config: AntigravityBotConfig;
  private bot: QQBot | null = null;
  private readonly sessionManager: AntigravitySessionManager;
  private readonly replyLimiter = new ReplyLimiter({ limit: 4 });
  private isRunning = false;

  public constructor(config: AntigravityBotConfig = {}) {
    this.config = {
      requireMention: config.requireMention ?? true,
      streaming: config.streaming ?? (process.env.QQBOT_STREAMING !== 'false'),
      textChunkLimit: config.textChunkLimit ?? 4000,
      streamThrottleMs: config.streamThrottleMs ?? 600,
      groupSessionScope: config.groupSessionScope ?? 'user',
      debug: config.debug ?? Boolean(process.env.DEBUG),
      ...config,
    };

    this.sessionManager = new AntigravitySessionManager(
      { idleTimeoutMs: Number(process.env.AGY_IDLE_TIMEOUT_MS || 2 * 60 * 60 * 1000), ...(this.config.antigravity || {}) },
      this.config.groupSessionScope,
    );
  }

  public get sessions(): AntigravitySessionManager {
    return this.sessionManager;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    // 1. Resolve credentials
    const creds = await resolveCredentials({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      debug: this.config.debug,
    });

    this.config.appId = creds.appId;
    this.config.appSecret = creds.appSecret;

    // 2. Initialize QQBot
    this.bot = new QQBot({
      appId: creds.appId,
      appSecret: creds.appSecret,
      transport: 'websocket',
      baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.bot.qq.com',
      tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://bots.qq.com',
      markdownSupport: true,
      logger: this.config.debug ? console : {
        info: () => {},
        warn: console.warn,
        error: console.error,
        debug: () => {},
      },
    });

    // 3. Register middlewares
    this.bot.use(errorHandler());
    this.bot.use(messageFilter({ skipSelfEcho: false }));
    this.bot.use(mentionGate({ requireMentionInGroup: this.config.requireMention ?? true }));
    this.bot.use(quoteRef({
      maxSize: 500,
      preferMsgElements: true,
    }));

    // 4. Register message handler
    this.bot.on('message', async (ctx: MiddlewareContext, msg?: QQBotInboundMessage) => {
      await this.handleIncomingMessage(ctx, msg);
    });

    this.bot.on('ready', () => {
      console.log(`\n======================================================`);
      console.log(` [Antigravity QQBot] Ready & Connected!`);
      void defaultPixivService.llmResolver.warmUp();
      console.log(` AppID: ${creds.appId}`);
      console.log(` Engine: Antigravity CLI (${this.config.antigravity?.agyPath || 'default agy'})`);
      console.log(`======================================================\n`);
    });

    this.bot.on('error', (err: unknown) => {
      console.error('[Antigravity QQBot] Bot error:', err);
    });

    this.isRunning = true;
    await this.bot.start();
  }

  private async handleIncomingMessage(ctx: MiddlewareContext, msg?: QQBotInboundMessage): Promise<void> {
    const rawMsg = msg ?? ctx.message;
    const target: ReplyTarget = rawMsg.replyTarget ?? ctx.replyTarget;
    const scope = target.scope; // 'c2c' | 'group'
    const targetId = target.targetId;
    const userId = rawMsg.senderId || targetId;

    let content = (rawMsg.content || '').trim();

    // Strip bot @mention tag if present (handles <@!12345>, <@HEX...>, <@all>, etc.)
    content = content.replace(/<@!?[^>]+>\s*/g, '').trim();

    // Collect quoted text if present
    const quote = (ctx.state as any)?.quote;
    const quoteText = (quote?.text || quote?.entry?.content || '').trim();
    if (quoteText) {
      content = `[引用消息开始]\n${quoteText}\n[引用消息结束]\n${content}`;
    }

    // Collect attachments from message and quoted elements
    const rawAttachments: InboundAttachment[] = [
      ...(((rawMsg as any)?.attachments as InboundAttachment[]) || []),
      ...((((ctx.message as any)?.attachments) as InboundAttachment[]) || []),
      ...((((ctx.state as any)?.quote?.attachments) as InboundAttachment[]) || []),
    ];

    const uniqueAttachments = Array.from(
      new Map(rawAttachments.filter(a => a && a.url).map(a => [a.url, a])).values()
    );

    let downloadedMedia: DownloadedMedia[] = [];
    if (uniqueAttachments.length > 0) {
      downloadedMedia = await downloadImageAttachments(uniqueAttachments, this.config.debug);
    }

    if (!content && downloadedMedia.length === 0) {
      if (scope === 'group') {
        await this.sendReply(target, '你好！我是 Antigravity AI 助手，有什么可以帮你的？发送 /help 查看帮助。');
      }
      return;
    }

    // Command handling (only if pure command without images)
    if (content.startsWith('/') && downloadedMedia.length === 0) {
      const handled = await this.handleCommand(target, content, userId);
      if (handled) return;
    }

    // 明文要图（如「来五张巨乳大姐姐」）软路由到 /pixiv，避免 Gemini 安全策略拒答且不调工具
    if (downloadedMedia.length === 0 && looksLikePixivImageAsk(content)) {
      const nq = parseNaturalPixivQuery(content);
      if (nq.keyword) {
        const routed = `/pixiv ${nq.keyword}${nq.count ? ` ${nq.count}` : ''}`;
        console.log(`[Antigravity QQBot] Soft-route image ask -> ${routed}`);
        const handled = await this.handleCommand(target, routed, userId);
        if (handled) return;
      }
    }

    const fullPrompt = buildPromptWithMedia(content, downloadedMedia);

    if (this.config.debug || downloadedMedia.length > 0) {
      console.log(`[Antigravity QQBot] Inbound [${scope}:${targetId}] from ${userId}: "${content}" (media: ${downloadedMedia.length})`);
    }

    // Process turn with Antigravity
    await this.processTurn(target, fullPrompt, userId);
  }

  private async handleCommand(target: ReplyTarget, cmdText: string, userId: string): Promise<boolean> {
    const [cmd] = cmdText.split(/\s+/);
    if (!cmd) return false;
    switch (cmd.toLowerCase()) {
      case '/help': {
        const helpText = [
          '🤖 **Google Antigravity QQBot 帮助指南**',
          '',
          '- 直接发送问题或需求，机器人将调用 Antigravity Agent 执行并回复',
          '- `/clear` 或 `/reset`：清空当前会话记忆，开启新对话',
          '- `/pixiv <关键词> [数量]`：检索并投递插画（多标签须同时命中，1~5 张）',
          '- `/status`：查看当前会话状态及 Antigravity 运行信息',
          '- `/ping`：健康检查',
          '- `/help`：查看此帮助信息',
        ].join('\n');
        await this.sendReply(target, helpText);
        return true;
      }

      case '/clear':
      case '/reset':
      case '/new': {
        const session = await this.sessionManager.resetSession(target.scope, target.targetId, userId);
        const reply = `✅ 会话记忆已清空，开启新上下文。\n会话 ID: \`${session.conversationId}\``;
        await this.sendReply(target, reply);
        return true;
      }

      case '/status':
      case '/bot-status': {
        const session = this.sessionManager.getOrCreateSession(target.scope, target.targetId, userId);
        const isRunning = session.process?.isRunning ?? false;
        const isBusy = session.process?.isBusy ?? false;
        const statusText = [
          '📊 **Antigravity 会话状态**',
          `- Scope: \`${target.scope}\``,
          `- Conversation ID: \`${session.conversationId}\``,
          `- 轮次 Epoch: \`${session.epoch}\``,
          `- 进程状态: \`${isRunning ? (isBusy ? '处理中 (BUSY)' : '空闲 (IDLE)') : '未启动 (STOPPED)'}\``,
          `- 排队任务数: \`${session.queue.length}\``,
        ].join('\n');
        await this.sendReply(target, statusText);
        return true;
      }

      case '/ping': {
        await this.sendReply(target, 'pong 🏓 Antigravity Agent 在线');
        return true;
      }

      case '/pixiv': {
        const rawTokens = cmdText.trim().split(/\s+/).slice(1);
        if (rawTokens.length === 0) {
          await this.sendReply(target, '📌 请输入角色或标签名，例如：`/pixiv 信浓` 或 `/pixiv 信浓 泳装 2`');
          return true;
        }
        const nq = parseNaturalPixivQuery(rawTokens.join(' '));
        const count = nq.count ?? 1;
        const keyword = nq.keyword;
        if (!keyword) {
          await this.sendReply(target, '📌 请输入角色或标签名，例如：`/pixiv 信浓` 或 `/pixiv 信浓 泳装 2`');
          return true;
        }
        const chatKey = `${target.scope}:${target.targetId}`;
        const cdResult = defaultPixivService.consumeCooldown(chatKey);
        if (!cdResult.allowed) {
          await this.sendReply(target, `⏳ 技能冷却中，请等待 ${cdResult.remainingSec} 秒后再试~`);
          return true;
        }

        try {
          const res = await defaultPixivService.searchIllustrations(chatKey, keyword, count);
          if (res.blocked) {
            await this.sendReply(target, `🚫 ${res.blockReason || '请求被系统安全策略拦截。'}`);
            return true;
          }
          if (!res.illustrations || res.illustrations.length === 0) {
            await this.sendReply(target, res.notice
              ? `🔍 ${res.notice}`
              : `🔍 未找到关于「${keyword}」的精选插画，换个角色或标签试试吧~`);
            return true;
          }

          if (res.corrected) console.log(`[pixiv] ${res.corrected}`);
          for (const illust of res.illustrations) {
            if (illust.localPath) {
              try {
                if (this.bot?.sendImage) {
                  // 图片与画师合成 1 条消息，避免超过 QQ 被动回复 5 条上限
                  await this.bot.sendImage(target, { localPath: illust.localPath }, { content: `🎨 画师：${illust.artist}` });
                }
              } catch {}
            }
          }

          if (res.exhaustedReset) {
            await this.sendReply(target, `🎉 已看完全部「${res.tag}」精选插画，已为你开启新一轮循环！`);
          }
          return true;
        } catch (err) {
          await this.sendReply(target, `❌ 检索失败：${err instanceof Error ? err.message : String(err)}`);
          return true;
        }
      }

      default:
        return false;
    }
  }

  private async processTurn(target: ReplyTarget, prompt: string, userId: string): Promise<void> {
    const isC2C = target.scope === 'c2c';
    const canStream = this.config.streaming && isC2C && !!target.msgId;

    if (canStream) {
      await this.processStreamingTurn(target, prompt, userId);
    } else {
      await this.processStaticTurn(target, prompt, userId);
    }
  }

  /**
   * Process a turn using real-time QQ streaming for C2C chats.
   */
  private async processStreamingTurn(target: ReplyTarget, prompt: string, userId: string): Promise<void> {
    let streamSession: any = null;
    let accumulatedText = '';
    let streamFailed = false;
    let sentAnyStreamChunk = false;
    let lastFlushTime = 0;
    let updateTimer: NodeJS.Timeout | null = null;
    let chain: Promise<void> = Promise.resolve();
    const throttleMs = this.config.streamThrottleMs ?? 600;

    const enqueueFlush = (textToFlush: string) => {
      if (!streamSession || streamFailed || !textToFlush) return;
      chain = chain.then(async () => {
        if (streamFailed || !streamSession) return;
        try {
          lastFlushTime = Date.now();
          await streamSession.update(textToFlush);
          sentAnyStreamChunk = true;
        } catch (err) {
          streamFailed = true;
          if (this.config.debug) {
            console.warn('[Antigravity QQBot] Stream update failed:', err);
          }
        }
      });
    };

    try {
      // Open stream session
      try {
        streamSession = this.bot!.openStream({
          target,
          throttleMs,
        });
      } catch (err) {
        streamFailed = true;
        if (this.config.debug) {
          console.warn('[Antigravity QQBot] Failed to open stream session, falling back to static:', err);
        }
      }

      const response = await this.sessionManager.executeTurn(
        target.scope,
        target.targetId,
        userId,
        prompt,
        {
          onDelta: (delta: string) => {
            accumulatedText += delta;
            if (streamSession && !streamFailed) {
              const now = Date.now();
              if (now - lastFlushTime >= throttleMs) {
                if (updateTimer) {
                  clearTimeout(updateTimer);
                  updateTimer = null;
                }
                enqueueFlush(accumulatedText);
              } else if (!updateTimer) {
                updateTimer = setTimeout(() => {
                  updateTimer = null;
                  enqueueFlush(accumulatedText);
                }, throttleMs - (now - lastFlushTime));
              }
            }
          },
        },
      );

      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }

      // Wait for all queued updates to settle
      await chain;

      // Extract and deliver any local media files referenced in the agent output
      const rawFinalText = response || accumulatedText || '';
      const cwd = this.config.antigravity?.cwd || process.cwd();
      const { cleanedText, filesToSend } = extractOutboundMedia(rawFinalText, cwd);

      // If stream was actively used, ensure prefix compatibility with previously sent chunks
      let finalStreamText = cleanedText;
      if (sentAnyStreamChunk && accumulatedText && !cleanedText.startsWith(accumulatedText)) {
        finalStreamText = accumulatedText;
      }

      if (streamSession && !streamFailed && sentAnyStreamChunk) {
        try {
          if (finalStreamText && finalStreamText !== accumulatedText) {
            await streamSession.update(finalStreamText);
          }
          await streamSession.complete();
        } catch (err) {
          if (this.config.debug) {
            console.warn('[Antigravity QQBot] Stream complete failed, falling back to static send:', err);
          }
          if (cleanedText) {
            // Drop target.msgId since it was already consumed by the stream attempt
            await this.sendReply({ scope: target.scope, targetId: target.targetId }, cleanedText);
          }
        }
      } else {
        // Stream session was not used or failed early: cancel and fall back to static reply
        if (streamSession) {
          try {
            streamSession.cancel?.();
          } catch {}
        }
        if (cleanedText) {
          await this.sendReply(target, cleanedText);
        }
      }

      // Auto-deliver any extracted media files
      for (const file of filesToSend) {
        try {
          await sendMediaFile(this.bot!, target, file);
        } catch (err) {
          console.warn('[Antigravity QQBot] Failed to auto-deliver media file:', file, err);
        }
      }
      return;
    } catch (err) {
      if (updateTimer) {
        clearTimeout(updateTimer);
      }
      if (streamSession) {
        try {
          await streamSession.complete();
        } catch {}
      }

      const fallbackTarget = sentAnyStreamChunk
        ? { scope: target.scope, targetId: target.targetId }
        : target;
      const errMsg = `❌ 处理失败: ${err instanceof Error ? err.message : String(err)}`;
      console.error('[Antigravity QQBot] Turn execution error:', err);
      await this.sendReply(fallbackTarget, errMsg);
    }
  }

  /**
   * Process a turn and send final chunked Markdown response.
   */
  private async processStaticTurn(target: ReplyTarget, prompt: string, userId: string): Promise<void> {
    try {
      const response = await this.sessionManager.executeTurn(
        target.scope,
        target.targetId,
        userId,
        prompt,
      );

      const cwd = this.config.antigravity?.cwd || process.cwd();
      const { cleanedText, filesToSend } = extractOutboundMedia(response || '', cwd);

      if (cleanedText) {
        await this.sendReply(target, cleanedText);
      }

      // Auto-deliver any extracted media files
      for (const file of filesToSend) {
        try {
          await sendMediaFile(this.bot!, target, file);
        } catch (err) {
          console.warn('[Antigravity QQBot] Failed to auto-deliver media file:', file, err);
        }
      }
    } catch (err) {
      const errMsg = `❌ 处理失败: ${err instanceof Error ? err.message : String(err)}`;
      console.error('[Antigravity QQBot] Static turn execution error:', err);
      await this.sendReply(target, errMsg);
    }
  }

  /**
   * Splits message according to QQ length limits and sends via markdown or text.
   */
  public async sendReply(target: ReplyTarget, text: string): Promise<void> {
    if (!this.bot || !text) return;

    const limit = this.config.textChunkLimit ?? 4000;
    const chunks = chunkMarkdownText(text, limit);

    for (const chunk of chunks) {
      // Check passive reply limit
      let sendTarget: ReplyTarget = target;
      if (target.msgId) {
        const limitRes = this.replyLimiter.checkLimit(target.msgId);
        if (limitRes.allowed) {
          this.replyLimiter.record(target.msgId);
        } else {
          // Fall back to proactive send without msgId
          sendTarget = {
            scope: target.scope,
            targetId: target.targetId,
          };
        }
      }

      try {
        await this.bot.sendMarkdown(sendTarget, chunk);
      } catch (err) {
        if (this.config.debug) {
          console.warn('[Antigravity QQBot] sendMarkdown failed, falling back to sendText:', err);
        }
        try {
          await this.bot.sendText(sendTarget, chunk);
        } catch (e) {
          console.error('[Antigravity QQBot] sendText also failed:', e);
        }
      }
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    await this.sessionManager.disposeAll();
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    console.log('[Antigravity QQBot] Bot stopped.');
  }
}
