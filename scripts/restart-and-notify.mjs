import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

async function main() {
  console.log('[restart-and-notify] Waiting 2.5 seconds for current turn to complete output...');
  await sleep(2500);

  console.log('[restart-and-notify] Restarting agy-qqbot.service via systemctl...');
  try {
    execSync('sudo systemctl restart agy-qqbot.service', { stdio: 'inherit' });
  } catch (err) {
    console.error('[restart-and-notify] Restart failed:', err);
    return;
  }

  console.log('[restart-and-notify] Waiting for service to become active...');
  let active = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      const status = execSync('systemctl is-active agy-qqbot.service', { encoding: 'utf8' }).trim();
      if (status === 'active') {
        console.log('[restart-and-notify] Service is active!');
        active = true;
        break;
      }
    } catch {}
  }

  if (!active) {
    console.error('[restart-and-notify] Service failed to become active in time.');
    return;
  }

  // Extra 3s to let QQBot initialize and connect WebSocket
  await sleep(3000);

  console.log('[restart-and-notify] Sending proactive notification to QQ private chat...');
  const bot = new QQBot({
    appId: process.env.QQBOT_APPID || '1906142430',
    appSecret: process.env.QQBOT_SECRET || '0odSI8zqiaTNHC73zwtrqpppqrtvy15A',
  });

  const target = {
    scope: 'c2c',
    targetId: 'B092EDDDBCC96D1B84DEE7E3646BD2B9',
  };

  const message = [
    '🤖 **QQ 机器人服务已成功重启并上线！**',
    '',
    '✨ **最新 Pixiv v3.0 整改特性已生效**：',
    '• 🛡️ 实体消歧与互斥实体组纯度校验（彻底杜绝张冠李戴）',
    '• 🚫 抽象/猎奇/恶搞负向黑名单与 AI 生成图默认隔离',
    '• 🌊 5 阶梯 Quality Waterfall 收藏漏斗与半衰期综合打分',
    '• 💾 本地缓存防投毒净化、真 LRU 轮转与双副本容灾',
    '',
    '👉 您可以直接发送：`/pixiv 信浓` 或 `/pixiv 爱丽丝 2` 开始体验！',
  ].join('\n');

  try {
    const res = await bot.sendText(target, message);
    console.log('[restart-and-notify] Message sent successfully! Msg ID:', res.id);
  } catch (err) {
    console.error('[restart-and-notify] Failed to send message:', err);
  }
}

main().catch(console.error);
