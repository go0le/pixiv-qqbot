/**
 * Pixiv 登录态。
 * refresh token 走官方 app OAuth；PHPSESSID / 完整 Cookie 走网页 AJAX。
 * client_id / client_secret 是 Pixiv Android 客户端公开的应用凭据，不是用户密钥。
 */

const OAUTH_URL = 'https://oauth.secure.pixiv.net/auth/token';
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';

export const PIXIV_APP_USER_AGENT = 'PixivAndroidApp/6.127.0 (Android 14; Pixel 6)';

export interface PixivCredentials {
  refreshToken: string;
  phpSessId: string;
  cookie: string;
  proxyBaseUrl: string;
}

export interface SearchAuth {
  headers: Record<string, string>;
  /** 有可用 access token 且没把网页反代设成搜索入口时，走 app-api。 */
  appApi: boolean;
  proxyBaseUrl: string;
}

export function readPixivCredentials(env: NodeJS.ProcessEnv = process.env): PixivCredentials {
  return {
    refreshToken: (env.PIXIV_REFRESH_TOKEN || '').trim(),
    phpSessId: (env.PIXIV_PHPSESSID || '').trim(),
    cookie: (env.PIXIV_COOKIE || '').trim(),
    proxyBaseUrl: (env.PIXIV_PROXY_BASE_URL || '').trim().replace(/\/$/, ''),
  };
}

export function cookieHeader(creds: PixivCredentials): string | undefined {
  if (creds.cookie) return creds.cookie;
  if (creds.phpSessId) return `PHPSESSID=${creds.phpSessId}`;
  return undefined;
}

export function hasPixivCredentials(creds: PixivCredentials = readPixivCredentials()): boolean {
  return Boolean(creds.refreshToken || creds.phpSessId || creds.cookie);
}

export class PixivAuth {
  private accessToken = '';
  private expiresAt = 0;
  private cachedRefresh = '';

  public async getAccessToken(refreshToken: string, timeoutMs: number): Promise<string> {
    const now = Date.now();
    if (this.cachedRefresh === refreshToken && this.accessToken && now < this.expiresAt - 300_000) {
      return this.accessToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        get_secure_url: '1',
      });
      const resp = await fetch(OAUTH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': PIXIV_APP_USER_AGENT,
        },
        body,
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`Pixiv token HTTP ${resp.status}`);
      }
      const json = await resp.json() as Record<string, unknown>;
      const payload = (json.response && typeof json.response === 'object'
        ? json.response
        : json) as Record<string, unknown>;
      const token = payload.access_token;
      if (typeof token !== 'string' || !token) {
        throw new Error('Pixiv token response missing access_token');
      }
      const expiresIn = Number(payload.expires_in ?? 3600);
      this.cachedRefresh = refreshToken;
      this.accessToken = token;
      this.expiresAt = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000;
      return token;
    } finally {
      clearTimeout(timer);
    }
  }
}
