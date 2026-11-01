/**
 * Deterministic UUID generator for Antigravity conversations.
 *
 * Maps a QQ session key (e.g. `c2c:<user_openid>` or `group:<group_openid>:<user_openid>`)
 * to a persistent UUID v4-formatted string derived from SHA-256.
 *
 * This ensures that a QQ conversation resumes the exact same conversation ID across bot restarts,
 * while allowing user-triggered resets (`/clear` or `/reset`) via epoch increments.
 */
import { createHash } from 'node:crypto';

export function deriveConversationId(sessionKey: string, epoch = 0): string {
  const hash = createHash('sha256')
    .update(`agy:qqbot:${sessionKey}:epoch:${epoch}`)
    .digest('hex');

  // Format as RFC 4122 compliant UUID (version 4-like, variant 1)
  const part1 = hash.slice(0, 8);
  const part2 = hash.slice(8, 12);
  const part3 = '4' + hash.slice(13, 16); // version 4
  const part4 = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.slice(18, 20); // variant
  const part5 = hash.slice(20, 32);

  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
}

export function buildSessionKey(
  scope: 'c2c' | 'group',
  targetId: string,
  userId?: string,
  groupScope: 'user' | 'group' = 'user',
): string {
  if (scope === 'c2c') {
    return `c2c:${targetId}`;
  }
  if (groupScope === 'group') {
    return `group:${targetId}`;
  }
  return `group:${targetId}:${userId || 'anonymous'}`;
}
