/**
 * /pixiv 命令 — 检索并投递高质量 Pixiv 二次元插画 (v3.0 规范)
 *
 * 格式：
 *   /pixiv <标签1> [标签2] ... [数量]
 *   例如：
 *     /pixiv 信浓
 *     /pixiv 信浓 泳装 2
 *     /pixiv 爱丽丝 3
 *
 * 特性：
 * - 多 Tag 输入支持：智能解析多关键词，末尾数字解析为数量（上限 3 张）
 * - 黑名单防御：请求男同、猎奇、AI、福瑞等标签时，明文拒绝且不扣 CD
 * - 灰名单受控：默认避免 R18/口交等内容，仅放行用户显式请求的对应灰名单标签
 * - 冷却限制：单会话 15 秒 CD
 * - 多图发送：每张间隔 ≥1500ms 避开 QQ 平台频率风控
 * - 极简标注：每张图附带「🎨 画师：{artist}」
 * - 耗尽兜底：全部看光且满足 120s 冷却时友好提示并重新循环
 */
import type { CategorizedCommand, CommandDeps } from './types.ts';
import { checkRequestBlacklist, defaultPixivService } from '../pixiv/index.ts';
import { getScopePeer } from '../shared/index.ts';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function pixivCommand(_deps?: CommandDeps): CategorizedCommand {
  return {
    name: 'pixiv',
    category: 'qqbot',
    description: '检索并投递 Pixiv 高质量插画（支持多Tag、原图画质、黑白灰名单管控）',
    usage: [
      '/pixiv <标签1> [标签2] ... [数量]',
      '',
      '参数说明：',
      '  标签：角色名或属性（如：信浓、爱丽丝、流萤、泳装、白丝）',
      '  数量：可选，1~3 张，默认为 1 张（放在最后）',
      '  多个标签须同时命中（例如：信浓 + 泳装）',
      '',
      '示例：',
      '  /pixiv 信浓',
      '  /pixiv 信浓 泳装 2',
      '  /pixiv 爱丽丝 3',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const chatKey = `${scope}:${peerId}`;
      const args = cmdCtx.command.args;

      if (!args || args.length === 0) {
        return '📌 请输入要搜索的角色或标签名，例如：`/pixiv 信浓` 或 `/pixiv 信浓 泳装 2`';
      }

      // 1. 智能拆分多 Tag 与末尾出图数量
      let count = 1;
      let tagTokens = args.map(a => a.trim()).filter(Boolean);

      if (tagTokens.length > 1) {
        const lastToken = tagTokens[tagTokens.length - 1]!;
        if (/^[1-9]\d*$/.test(lastToken)) {
          const parsed = parseInt(lastToken, 10);
          if (!Number.isNaN(parsed)) {
            count = Math.max(1, Math.min(3, parsed));
            tagTokens = tagTokens.slice(0, -1);
          }
        }
      }

      if (tagTokens.length === 0) {
        return '📌 请输入要搜索的角色或标签名，例如：`/pixiv 信浓` 或 `/pixiv 信浓 泳装 2`';
      }

      // 2. 黑名单前置拦截检测：若包含男同/猎奇/AI/福瑞等，不扣 CD 并明文拒绝
      const blCheck = checkRequestBlacklist(tagTokens);
      if (blCheck.blocked) {
        return `🚫 请求包含违规/禁止标签「${blCheck.matchedTag}」（黑名单分类：${blCheck.categoryName}），系统拒绝检索。`;
      }

      // 3. 检查会话 15 秒冷却 CD
      const cdResult = defaultPixivService.consumeCooldown(chatKey);
      if (!cdResult.allowed) {
        return `⏳ 技能冷却中，请等待 ${cdResult.remainingSec} 秒后再试~`;
      }

      // 4. 执行综合检索
      const target = cmdCtx.replyTarget;
      const bot = cmdCtx.bot;

      try {
        const result = await defaultPixivService.searchIllustrations(chatKey, tagTokens, count);

        if (result.blocked) {
          return `🚫 ${result.blockReason || '请求被系统安全策略拦截。'}`;
        }

        if (!result.illustrations || result.illustrations.length === 0) {
          if (result.notice) return `🔍 ${result.notice}`;
          const displayTag = result.tag || tagTokens.join(' ');
          return `🔍 未找到关于「${displayTag}」的精选插画，换个角色或标签试试吧~`;
        }

        // 5. 逐张发送原生图片并附带画师极简标注（多图间隔 1.5s 避开频控）
        let sentCount = 0;
        for (let i = 0; i < result.illustrations.length; i++) {
          const illust = result.illustrations[i]!;
          if (illust.localPath) {
            try {
              if (sentCount > 0) {
                await sleep(1500); // 间隔 1500ms
              }
              if (bot?.sendImage) {
                await bot.sendImage(target, { localPath: illust.localPath });
                if (bot?.sendText) {
                  await bot.sendText(target, `🎨 画师：${illust.artist}`);
                }
                sentCount++;
              }
            } catch {
              // 忽略单张发送失败
            }
          }
        }

        // 若检索到了图片但向 QQ 投递全军覆没，给用户明确提示而不是静默黑洞 (P2-06)
        if (sentCount === 0 && result.illustrations.length > 0) {
          return `⚠️ 已检索到 ${result.illustrations.length} 张插画，但在向 QQ 投递时发送受阻（可能触发平台审核或文件过大），请稍后再试~`;
        }

        if (result.exhaustedReset) {
          return `🎉 已看完全部「${result.tag}」精选插画，已为你开启新一轮循环！`;
        }

        return { kind: 'noop' };
      } catch (err) {
        return `❌ 检索失败：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
