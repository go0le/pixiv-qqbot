import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const VERIFIER_FILE = path.join(homedir(), '.dsh-qqbot', 'pixiv_pkce_verifier.txt');
const ENV_FILE = process.env.QQBOT_ENV_FILE || new URL('../.env.qqbot', import.meta.url).pathname;

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const ALT_CLIENT_SECRET = 'lsACyP96orsfJ6itlE2b7e7h5jB2s3v6';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';

const action = process.argv[2] || 'generate';

if (action === 'generate') {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  
  fs.mkdirSync(path.dirname(VERIFIER_FILE), { recursive: true });
  fs.writeFileSync(VERIFIER_FILE, verifier, 'utf8');

  const loginUrl = `https://app-api.pixiv.net/web/v1/login?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`;
  console.log('LOGIN_URL=' + loginUrl);
  console.log('VERIFIER=' + verifier);
} else if (action === 'exchange') {
  let rawCode = process.argv[3];
  if (!rawCode) {
    console.error('Usage: node scripts/pixiv-oauth.mjs exchange <code>');
    process.exit(1);
  }

  // Support pasting full URL like pixiv://account/login?code=xxx or https://app-api.pixiv.net/...code=xxx
  const codeMatch = rawCode.match(/code=([^&]+)/);
  const code = codeMatch ? decodeURIComponent(codeMatch[1]) : rawCode.trim();

  if (!fs.existsSync(VERIFIER_FILE)) {
    console.error('Verifier file not found at ' + VERIFIER_FILE + '. Run generate first.');
    process.exit(1);
  }
  const verifier = fs.readFileSync(VERIFIER_FILE, 'utf8').trim();

  console.log('Exchanging authorization code for refresh_token...');
  
  async function tryExchange(secret) {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: secret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      include_policy: 'true',
    });

    return fetch('https://oauth.secure.pixiv.net/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)',
      },
      body,
    });
  }

  let resp = await tryExchange(CLIENT_SECRET);
  if (!resp.ok) {
    console.warn('First secret failed (' + resp.status + '), trying fallback secret...');
    resp = await tryExchange(ALT_CLIENT_SECRET);
  }

  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('Failed to parse response:', text);
    process.exit(1);
  }

  if (!resp.ok || json.errors || json.has_error) {
    console.error('Pixiv OAuth error:', JSON.stringify(json, null, 2));
    process.exit(1);
  }

  const payload = (json.response && typeof json.response === 'object') ? json.response : json;
  const refreshToken = payload.refresh_token;
  const accessToken = payload.access_token;
  const user = payload.user;

  if (!refreshToken) {
    console.error('No refresh_token in response:', json);
    process.exit(1);
  }

  console.log('SUCCESS! Authenticated as:', user ? `${user.name} (${user.account}, id=${user.id})` : 'Unknown');

  // Update .env.qqbot
  let envContent = '';
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
  }

  if (envContent.includes('PIXIV_REFRESH_TOKEN=')) {
    envContent = envContent.replace(/PIXIV_REFRESH_TOKEN=.*(\r?\n|$)/, `PIXIV_REFRESH_TOKEN=${refreshToken}\n`);
  } else {
    envContent += `\nPIXIV_REFRESH_TOKEN=${refreshToken}\n`;
  }

  fs.writeFileSync(ENV_FILE, envContent, 'utf8');
  console.log('Updated ' + ENV_FILE + ' with PIXIV_REFRESH_TOKEN');

  // Test Pixiv app-api search with access_token
  console.log('Testing Pixiv app-api search with token...');
  const testResp = await fetch('https://app-api.pixiv.net/v1/search/illust?word=%E4%BF%A1%E6%BF%83&search_target=partial_match_for_tags&sort=date_desc&filter=for_ios', {
    headers: {
      'User-Agent': 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)',
      'Authorization': `Bearer ${accessToken}`,
    }
  });
  console.log('Test search HTTP status:', testResp.status);
  if (testResp.ok) {
    const testJson = await testResp.json();
    console.log(`Test search returned ${testJson.illusts?.length || 0} illustrations!`);
  }

  // Restart agy-qqbot.service
  console.log('Restarting agy-qqbot.service...');
  try {
    execSync('sudo systemctl restart agy-qqbot.service', { stdio: 'inherit' });
    console.log('Service restarted successfully!');
  } catch (err) {
    console.warn('Failed to restart service automatically:', err.message);
  }
}
