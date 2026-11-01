#!/usr/bin/env node
/**
 * Antigravity QQBot CLI Launcher
 *
 * Usage:
 *   npx agy-qqbot [options]
 *   node dist/bin/agy-qqbot.js
 *
 * Options:
 *   --appid <id>        QQBot AppID (or env QQBOT_APPID)
 *   --secret <secret>   QQBot AppSecret (or env QQBOT_SECRET)
 *   --agy-path <path>   Path to agy binary (or env AGY_PATH)
 *   --cwd <path>        Working directory for Antigravity
 *   --debug             Enable verbose debug logging
 *   --help              Show help
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AntigravityQQBot } from '../antigravity/index.ts';

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch {}
}

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '.env.qqbot'));

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
Antigravity QQBot — Connect QQ to Google Antigravity CLI

Options:
  --appid <id>        QQBot AppID (default: process.env.QQBOT_APPID)
  --secret <secret>   QQBot AppSecret (default: process.env.QQBOT_SECRET)
  --agy-path <path>   Path to agy executable (default: process.env.AGY_PATH or ~/.local/bin/agy)
  --cwd <path>        Agent working directory (default: process.cwd())
  --debug             Enable verbose debug logging
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  const bot = new AntigravityQQBot({
    appId: typeof args.appid === 'string' ? args.appid : undefined,
    appSecret: typeof args.secret === 'string' ? args.secret : undefined,
    debug: Boolean(args.debug || process.env.DEBUG),
    antigravity: {
      agyPath: typeof args['agy-path'] === 'string' ? args['agy-path'] : undefined,
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      debug: Boolean(args.debug || process.env.DEBUG),
    },
  });

  const onShutdown = async (sig: string) => {
    console.log(`\nReceived ${sig}, shutting down Antigravity QQBot...`);
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => onShutdown('SIGINT'));
  process.on('SIGTERM', () => onShutdown('SIGTERM'));

  try {
    await bot.start();
  } catch (err) {
    console.error('Failed to start Antigravity QQBot:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
