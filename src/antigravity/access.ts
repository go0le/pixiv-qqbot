/**
 * NapCat 机器人的访问控制：管理员 + 会话白/黑名单。
 *
 * 角色
 * - admin：在 `access.json` 的 admins 或环境变量 NAPCAT_ADMIN_IDS（逗号分隔的 QQ 号）里配置；代码里不写死任何 QQ 号。
 *   在私聊和群聊里都可以安排哈gemi做程序设计、Linux 运维等服务器工作；也是唯一能改白/黑名单的人。
 * - user：其他所有人，只能聊天和申请图片，不能让哈gemi在服务器上执行任何工作。
 *
 * 灰名单（pixiv 的 R-18、口交等）策略，按「会话」判定：
 * - allow（白名单会话）：用户明文点名灰名单词时放行，与 pixiv 的原有规则一致。
 * - deny（黑名单会话）：灰名单（含 R-18）当作黑名单处理，请求直接拒绝。
 * - default（既不在白名单也不在黑名单）：灰名单不生效，明文点名灰名单词同样拒绝。
 * pixiv 自己的黑名单（BL、猎奇、福瑞、AI 生成等）对所有会话始终生效，与本文件无关。
 *
 * 会话 = 群聊看群号，私聊看对方 QQ 号。白/黑名单只能由管理员命令或直接编辑 access.json 修改。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_ADMIN_IDS: string[] = [];
export const DEFAULT_ACCESS_FILE = process.env.NAPCAT_ACCESS_FILE
  ? resolve(process.env.NAPCAT_ACCESS_FILE)
  : resolve(homedir(), '.dsh-qqbot', 'access.json');

export type Scope = 'c2c' | 'group';
export type Role = 'admin' | 'user';
export type GreyPolicy = 'allow' | 'default' | 'deny';
/** 这条消息应该用哪一档的 Agent 运行环境 */
export type AgentTier = 'admin' | 'guest' | 'guest-grey';

interface AccessData {
  admins: string[];
  whitelist: { groups: string[]; users: string[] };
  blacklist: { groups: string[]; users: string[] };
}

function emptyData(): AccessData {
  return { admins: [...DEFAULT_ADMIN_IDS], whitelist: { groups: [], users: [] }, blacklist: { groups: [], users: [] } };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function uniq(list: unknown): string[] {
  return Array.isArray(list) ? Array.from(new Set(list.map(String).filter(isValidId))) : [];
}

export class AccessStore {
  private data: AccessData = emptyData();
  private mtimeMs = -1;

  public constructor(private readonly filePath = DEFAULT_ACCESS_FILE) {
    this.reload(true);
  }

  /** 文件被手工编辑后自动重新加载（按 mtime） */
  private reload(force = false): void {
    try {
      if (!existsSync(this.filePath)) {
        if (force) this.data = this.withEnvAdmins(emptyData());
        return;
      }
      const m = statSync(this.filePath).mtimeMs;
      if (!force && m === this.mtimeMs) return;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AccessData>;
      this.data = this.withEnvAdmins({
        admins: uniq(raw.admins).length ? uniq(raw.admins) : [...DEFAULT_ADMIN_IDS],
        whitelist: { groups: uniq(raw.whitelist?.groups), users: uniq(raw.whitelist?.users) },
        blacklist: { groups: uniq(raw.blacklist?.groups), users: uniq(raw.blacklist?.users) },
      });
      this.mtimeMs = m;
    } catch (err) {
      // 文件损坏：保留内存里上一份有效数据；首次加载就坏则用最严格的默认值
      console.warn('[Access] access.json 读取失败，沿用上一份配置:', err instanceof Error ? err.message : err);
    }
  }

  private withEnvAdmins(d: AccessData): AccessData {
    const extra = (process.env.NAPCAT_ADMIN_IDS || '').split(/[,\s]+/).filter(isValidId);
    d.admins = Array.from(new Set([...d.admins, ...extra]));
    return d;
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 管理员列表只存文件/环境变量里的值，不通过命令修改
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.filePath);
    try { this.mtimeMs = statSync(this.filePath).mtimeMs; } catch { /* ignore */ }
  }

  public isAdmin(userId: string | number): boolean {
    this.reload();
    return this.data.admins.includes(String(userId));
  }

  /** 全部管理员 QQ 号（运行告警私聊发给他们） */
  public adminIds(): string[] {
    this.reload();
    return [...this.data.admins];
  }

  public roleOf(userId: string | number): Role {
    return this.isAdmin(userId) ? 'admin' : 'user';
  }

  private listFor(kind: 'whitelist' | 'blacklist', scope: Scope): string[] {
    return scope === 'group' ? this.data[kind].groups : this.data[kind].users;
  }

  /**
   * 灰名单策略。黑名单优先于白名单（同时在两边时按黑名单处理，更保守）。
   * 群聊里只看群号；私聊看对方 QQ 号。
   */
  public greyPolicy(scope: Scope, targetId: string | number): GreyPolicy {
    this.reload();
    const id = String(targetId);
    if (this.listFor('blacklist', scope).includes(id)) return 'deny';
    if (this.listFor('whitelist', scope).includes(id)) return 'allow';
    return 'default';
  }

  /** 这条消息使用哪一档 Agent：管理员 → 完整权限；其他人 → 受限，白名单会话额外放开灰名单 */
  public tierFor(scope: Scope, targetId: string, userId: string): AgentTier {
    if (this.isAdmin(userId)) return 'admin';
    return this.greyPolicy(scope, targetId) === 'allow' ? 'guest-grey' : 'guest';
  }

  public add(kind: 'whitelist' | 'blacklist', scope: Scope, id: string): { ok: boolean; message: string } {
    if (!isValidId(id)) return { ok: false, message: 'ID 格式不对（只允许字母、数字、下划线、连字符）' };
    this.reload();
    const other = kind === 'whitelist' ? 'blacklist' : 'whitelist';
    const list = this.listFor(kind, scope);
    const otherList = this.listFor(other, scope);
    const moved = otherList.includes(id);
    if (moved) otherList.splice(otherList.indexOf(id), 1);
    if (!list.includes(id)) list.push(id);
    this.save();
    return { ok: true, message: `${scope === 'group' ? '群' : '私聊用户'} ${id} 已加入${kind === 'whitelist' ? '白名单' : '黑名单'}${moved ? `（并已从${other === 'whitelist' ? '白名单' : '黑名单'}移除）` : ''}` };
  }

  public remove(kind: 'whitelist' | 'blacklist', scope: Scope, id: string): { ok: boolean; message: string } {
    if (!isValidId(id)) return { ok: false, message: 'ID 格式不对' };
    this.reload();
    const list = this.listFor(kind, scope);
    const idx = list.indexOf(id);
    if (idx < 0) return { ok: false, message: `${id} 不在${kind === 'whitelist' ? '白名单' : '黑名单'}里` };
    list.splice(idx, 1);
    this.save();
    return { ok: true, message: `${id} 已从${kind === 'whitelist' ? '白名单' : '黑名单'}移除` };
  }

  public summary(): string {
    this.reload();
    const f = (l: string[]) => (l.length ? l.join(', ') : '（空）');
    return [
      `管理员：${f(this.data.admins)}`,
      `白名单群：${f(this.data.whitelist.groups)}`,
      `白名单私聊：${f(this.data.whitelist.users)}`,
      `黑名单群：${f(this.data.blacklist.groups)}`,
      `黑名单私聊：${f(this.data.blacklist.users)}`,
    ].join('\n');
  }
}
