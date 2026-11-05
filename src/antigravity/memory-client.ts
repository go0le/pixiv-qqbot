/**
 * MemoryOS（哈gemi 记忆库）的适配器侧客户端。
 *
 * 为什么由适配器调用、而不是让模型自己调 MCP 工具：
 * 记忆按 QQ 号隔离，QQ 号只能取自 OneBot 事件里的 user_id（可信）。
 * 如果让模型传 user_id，用户一句「用别人的 ID」就能越权读取别人的记忆。
 * 这里适配器起一个 MemoryOS MCP 子进程，自己说 JSON-RPC，user_id 由代码决定，模型碰不到。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export const DEFAULT_MEMORY_LAUNCHER = process.env.MEMORYOS_LAUNCHER || '/home/MIKU/external/MemoryOS/run_memoryos_mcp.sh';

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class MemoryClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private failedUntil = 0;
  /** 记忆库进程退出时回调（运行状况自检用）。expected = dispose() 主动结束的 */
  public onExit: ((code: number | null, signal: NodeJS.Signals | null, expected: boolean) => void) | null = null;

  public constructor(private readonly launcher = DEFAULT_MEMORY_LAUNCHER) {}

  public get available(): boolean {
    return existsSync(this.launcher);
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.launcher, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stderr.resume(); // 只丢弃日志，避免管道写满
      createInterface({ input: child.stdout }).on('line', line => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; } // 协议之外的行忽略
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(String(msg.error.message ?? 'MCP error')));
        else p.resolve(msg.result);
      });
      const fail = (err: Error) => {
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
        this.child = null;
        this.ready = null;
        this.failedUntil = Date.now() + 30_000; // 30 秒内不再反复拉起
      };
      child.on('error', e => { fail(e); reject(e); });
      child.on('exit', (code, signal) => {
        // dispose() 会先把 this.child 置空再结束进程：那种退出是预期的，也不能清掉之后新拉起的进程
        const current = this.child === child;
        if (current) fail(new Error(`memoryos exited (${code ?? signal})`));
        try { this.onExit?.(code, signal, !current); } catch { /* ignore */ }
      });
      this.rpc('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'napcat-adapter', version: '1' },
      }, 90_000).then(() => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        resolve();
      }).catch(e => { reject(e); this.dispose(); });
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child) return reject(new Error('memoryos not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`memoryos ${method} timeout`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** 调用一个记忆工具。串行执行（MemoryOS 一个进程一次只处理一件事）。 */
  private callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const job = this.queue.then(async () => {
      if (Date.now() < this.failedUntil) throw new Error('memoryos unavailable (cooling down)');
      await this.start();
      const res = await this.rpc('tools/call', { name, arguments: args }, timeoutMs);
      const text = res?.content?.[0]?.text;
      try { return JSON.parse(text); } catch { return { status: 'error', message: String(text).slice(0, 200) }; }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** 后台预热：提前拉起进程并加载嵌入模型，避免第一条消息等很久 */
  public warm(): void {
    if (!this.available) return;
    this.start().catch(err => console.warn('[Memory] 预热失败:', err instanceof Error ? err.message : err));
  }

  /**
   * 检索该用户的相关记忆，整理成一段可放进提示词的文字；没有有用内容返回 null。
   *
   * 召回构成（依据公开记忆评测的失分分析调整）：
   * - 近期原话（短期记忆，最多 SHORT_N 轮）：刚说过、还没被整理进中期的事实只在这里，
   *   之前不带这段导致「当天/3 天」题几乎全错；
   * - 相关往事（中期检索页，最多 PAGE_N 条，按时间排序）：带日期，便于处理改口、先后和相对日期；
   * - 用户长期知识 + 助手说过的话（分开标注主体，避免把助手建议记成用户说的）；
   * - 画像。
   * 每条都标注说话人和日期，并提示「同一件事以最近一次为准」。
   */
  public async recall(userId: string, query: string, timeoutMs = 8000): Promise<string | null> {
    const SHORT_N = 10;
    const PAGE_N = 7;
    const KNOW_N = 4;
    const r = await this.callTool('retrieve_memory', { user_id: userId, query, max_results: PAGE_N }, timeoutMs);
    if (!r || r.status !== 'success') return null;
    const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const day = (ts: unknown) => clip(ts, 16); // "YYYY-MM-DD HH:MM"
    const pair = (p: { user_input?: unknown; agent_response?: unknown; timestamp?: unknown }) =>
      `[${day(p.timestamp)}] 用户说「${clip(p.user_input, 160)}」→ 你答「${clip(p.agent_response, 160)}」`;

    const sections: string[] = [];
    const recent = Array.isArray(r.short_term_memory) ? r.short_term_memory.slice(-SHORT_N) : [];
    const recentKeys = new Set(recent.map((p: any) => `${clip(p.user_input, 60)}|${clip(p.timestamp, 19)}`));
    if (recent.length) sections.push(`近期原话（按时间）：\n${recent.map(pair).join('\n')}`);

    const pages = (Array.isArray(r.retrieved_pages) ? r.retrieved_pages : [])
      .filter((p: any) => !recentKeys.has(`${clip(p.user_input, 60)}|${clip(p.timestamp, 19)}`))
      .sort((a: any, b: any) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')))
      .slice(0, PAGE_N);
    if (pages.length) sections.push(`相关往事（按时间）：\n${pages.map(pair).join('\n')}`);

    const userKnow = (r.retrieved_user_knowledge ?? []).slice(0, KNOW_N)
      .map((k: any) => `- [${day(k.timestamp)}] ${clip(k.knowledge, 200)}`);
    if (userKnow.length) sections.push(`关于用户（长期整理）：\n${userKnow.join('\n')}`);

    const asstKnow = (r.retrieved_assistant_knowledge ?? []).slice(0, KNOW_N)
      .map((k: any) => `- [${day(k.timestamp)}] ${clip(k.knowledge, 200)}`);
    if (asstKnow.length) sections.push(`你自己说过/做过的（是你说的，不是用户说的）：\n${asstKnow.join('\n')}`);

    const profile = typeof r.user_profile === 'string' ? r.user_profile.trim() : '';
    if (profile && !/^no detailed user profile/i.test(profile)) sections.push(`画像：${clip(profile, 400)}`);

    if (!sections.length) return null;
    sections.push('提示：同一件事前后说法不同时，以日期最近的为准；记忆里没有的就说不记得，不要编。');
    return sections.join('\n\n');
  }

  public async remember(userId: string, userInput: string, agentResponse: string, timeoutMs = 120_000): Promise<void> {
    await this.callTool('add_memory', { user_id: userId, user_input: userInput, agent_response: agentResponse }, timeoutMs);
  }

  public dispose(): void {
    try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
    this.child = null;
    this.ready = null;
  }
}
