#!/usr/bin/env node
/**
 * NapCat QQBot CLI Launcher for Google Antigravity
 *
 * Usage:
 *   node dist/bin/napcat-qqbot.js [options]
 *
 * Options:
 *   --ws-url <url>      NapCat OneBot 11 WebSocket URL (default: ws://127.0.0.1:3001)
 *   --self-id <qq>      Bot QQ Number (default: NAPCAT_SELF_ID, or auto-detected after connecting)
 *   --agy-path <path>   Path to agy binary (or env AGY_PATH)
 *   --cwd <path>        Working directory for Antigravity
 *   --debug             Enable verbose debug logging
 *   --help              Show help
 */
// 必须最先导入：把 .env / .env.qqbot 读进 process.env，早于任何在模块加载时读 env 的常量
// （pixiv/history.ts 的 DEFAULT_HISTORY_FILE、access.ts 的 DEFAULT_ACCESS_FILE 等）。
import './load-env.ts';
import { NapCatOneBotAdapter } from '../antigravity/index.ts';

function parseArgs(): Record<string, string | boolean> {
  const args = process.argv.slice(2);
  const result: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--debug') {
      result.debug = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    console.log(`
NapCat QQBot — Connect NapCat (OneBot 11) to Google Antigravity Agent

Options:
  --ws-url <url>      OneBot 11 WebSocket URL (default: process.env.NAPCAT_WS_URL or ws://127.0.0.1:3001)
  --self-id <qq>      Bot QQ Number (default: process.env.NAPCAT_SELF_ID, or auto-detected after connecting)
  --agy-path <path>   Path to agy executable (default: process.env.AGY_PATH or ~/.local/bin/agy)
  --cwd <path>        Agent working directory (default: process.cwd())
  --debug             Enable verbose debug logging
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  const bot = new NapCatOneBotAdapter({
    wsUrl: typeof args['ws-url'] === 'string' ? args['ws-url'] : undefined,
    selfId: typeof args['self-id'] === 'string' ? args['self-id'] : undefined,
    debug: Boolean(args.debug || process.env.DEBUG),
    antigravity: {
      agyPath: typeof args['agy-path'] === 'string' ? args['agy-path'] : undefined,
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      debug: Boolean(args.debug || process.env.DEBUG),
    },
  });

  const onShutdown = async (sig: string) => {
    console.log(`\nReceived ${sig}, shutting down NapCat QQBot...`);
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => onShutdown('SIGINT'));
  process.on('SIGTERM', () => onShutdown('SIGTERM'));

  try {
    await bot.start();
  } catch (err) {
    console.error('Failed to start NapCat QQBot:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
