/**
 * Standalone QQ Bot credentials resolver.
 *
 * Resolves credentials in the following order:
 * 1. Explicit arguments (appId, appSecret)
 * 2. Environment variables: QQBOT_APPID / QQBOT_SECRET
 * 3. Fallback to interactive terminal QR code login via @tencent-connect/qqbot-connector
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startQrConnect, type QrConnectCredentials } from '@tencent-connect/qqbot-connector';
import qrcode from 'qrcode';

export interface Credentials {
  appId: string;
  appSecret: string;
}

export interface ResolveCredentialsOptions {
  appId?: string;
  appSecret?: string;
  debug?: boolean;
}

export function clickableLink(url: string): string {
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}

function loadEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(filePath)) return result;
  try {
    const content = readFileSync(filePath, 'utf8');
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
        result[key] = val;
      }
    }
  } catch {}
  return result;
}

function saveCredentialsToEnvFile(appId: string, appSecret: string): void {
  try {
    const envPath = resolve(process.cwd(), '.env.qqbot');
    const content = `# Antigravity QQBot Credentials\nQQBOT_APPID="${appId}"\nQQBOT_SECRET="${appSecret}"\n`;
    writeFileSync(envPath, content, 'utf8');
    console.log(`[QQBot Auth] 凭据已持久化至 ${envPath}`);
  } catch (err) {
    console.warn('[QQBot Auth] 凭据持久化至 .env.qqbot 失败:', err);
  }
}

export async function resolveCredentials(
  options: ResolveCredentialsOptions = {},
): Promise<Credentials> {
  // 1. Direct options or process.env
  let appId = options.appId || process.env.QQBOT_APPID;
  let appSecret = options.appSecret || process.env.QQBOT_SECRET;

  // 2. Check .env.qqbot in cwd
  if (!appId || !appSecret) {
    const envFile = loadEnvFile(resolve(process.cwd(), '.env.qqbot'));
    appId = appId || envFile.QQBOT_APPID;
    appSecret = appSecret || envFile.QQBOT_SECRET;
  }

  if (appId && appSecret) {
    return { appId, appSecret };
  }

  console.log('\n[QQBot Auth] 未检测到 QQBOT_APPID / QQBOT_SECRET，启动扫码绑定流程...\n');

  return new Promise<Credentials>((resolve, reject) => {
    let completed = false;

    const cleanupSignal = () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };

    const stop = startQrConnect({
      onQrDisplayed(qrUrl: string) {
        console.log('\n请使用手机 QQ 扫描下方二维码进行机器人授权绑定:');
        qrcode.toString(qrUrl, { type: 'terminal', small: true }, (err, str) => {
          if (!err && str) {
            console.log(str);
          }
          console.log('二维码链接 (Ctrl+点击直接打开):');
          console.log(`  ${clickableLink(qrUrl)}\n`);
        });
      },
      onSuccess(credentials: QrConnectCredentials[]) {
        if (completed) return;
        cleanupSignal();
        const cred = credentials[0];
        if (!cred) {
          completed = true;
          stop();
          reject(new Error('未获取到有效凭据'));
          return;
        }
        completed = true;
        console.log('\n[QQBot Auth] 扫码授权成功！AppID:', cred.appId);
        saveCredentialsToEnvFile(cred.appId, cred.appSecret);
        stop();
        resolve({
          appId: cred.appId,
          appSecret: cred.appSecret,
        });
      },
      onFailure(err: Error) {
        if (completed) return;
        cleanupSignal();
        completed = true;
        stop();
        reject(new Error(`扫码认证失败: ${err.message}`));
      },
      onQrExpired() {
        console.log('\n[QQBot Auth] 二维码已过期，正在刷新...');
      },
    });

    // Handle clean process abort
    const onSignal = () => {
      if (!completed) {
        cleanupSignal();
        completed = true;
        stop();
        reject(new Error('Auth aborted by user'));
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
