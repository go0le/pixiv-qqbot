/**
 * 读取 .env / .env.qqbot 到 process.env 的副作用模块。
 *
 * 必须在任何会读取 env 派生模块常量的模块之前导入（例如 pixiv/history.ts 的 DEFAULT_HISTORY_FILE、
 * antigravity/access.ts 的 DEFAULT_ACCESS_FILE 都是模块加载时求值的）。ESM 的 import 是提前、按顺序
 * 执行的，所以本模块放在入口文件的最前面 import，才能保证这些常量读到的是文件里的值，
 * 而不是进程默认值（上一轮审查 S5：加载顺序 bug 导致 PIXIV_HISTORY_FILE 不生效）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  } catch {
    /* ignore */
  }
}

loadEnvFile(resolve(process.cwd(), '.env'));
loadEnvFile(resolve(process.cwd(), '.env.qqbot'));
