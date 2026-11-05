import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deriveConversationId, buildSessionKey } from './session-id.ts';
import { AntigravitySessionManager } from './session-manager.ts';
import { AntigravityProcess } from './process.ts';

describe('Antigravity Session ID Derivation', () => {
  it('should generate valid RFC-4122 format UUIDs', () => {
    const id = deriveConversationId('c2c:user_12345');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should be deterministic for same key and epoch', () => {
    const id1 = deriveConversationId('group:group_999:user_111', 0);
    const id2 = deriveConversationId('group:group_999:user_111', 0);
    expect(id1).toBe(id2);
  });

  it('should generate distinct IDs for different epochs or targets', () => {
    const idEpoch0 = deriveConversationId('c2c:user_1', 0);
    const idEpoch1 = deriveConversationId('c2c:user_1', 1);
    const idUser2 = deriveConversationId('c2c:user_2', 0);

    expect(idEpoch0).not.toBe(idEpoch1);
    expect(idEpoch0).not.toBe(idUser2);
  });

  it('should format session keys correctly for c2c and group scopes', () => {
    expect(buildSessionKey('c2c', 'open_user_1')).toBe('c2c:open_user_1');
    expect(buildSessionKey('group', 'group_100', 'user_200', 'user')).toBe('group:group_100:user_200');
    expect(buildSessionKey('group', 'group_100', 'user_200', 'group')).toBe('group:group_100');
  });
});

describe('AntigravitySessionManager', () => {
  let manager: AntigravitySessionManager;

  beforeEach(() => {
    manager = new AntigravitySessionManager({ idleTimeoutMs: 1000 }, 'user');
  });

  afterEach(async () => {
    await manager.disposeAll();
  });

  it('should create and retrieve sessions with stable conversation IDs', () => {
    const session1 = manager.getOrCreateSession('c2c', 'target_user_a');
    const session2 = manager.getOrCreateSession('c2c', 'target_user_a');
    expect(session1).toBe(session2);
    expect(session1.conversationId).toBe(deriveConversationId('c2c:target_user_a', 0));
  });

  it('should isolate sessions between different users in same group when groupScope is user', () => {
    const sessionUserA = manager.getOrCreateSession('group', 'group_abc', 'user_1');
    const sessionUserB = manager.getOrCreateSession('group', 'group_abc', 'user_2');

    expect(sessionUserA.sessionKey).not.toBe(sessionUserB.sessionKey);
    expect(sessionUserA.conversationId).not.toBe(sessionUserB.conversationId);
  });

  it('should reset session epoch and conversation ID on resetSession', async () => {
    const initialSession = manager.getOrCreateSession('c2c', 'user_reset_test');
    const initialId = initialSession.conversationId;
    expect(initialSession.epoch).toBe(0);

    const resetSession = await manager.resetSession('c2c', 'user_reset_test');
    expect(resetSession.epoch).toBe(1);
    expect(resetSession.conversationId).not.toBe(initialId);
    expect(resetSession.conversationId).toBe(deriveConversationId('c2c:user_reset_test', 1));
  });
});

describe('AntigravityProcess Protocol Handling', () => {
  it('should parse init, step_update, and result events correctly', () => {
    const proc = new AntigravityProcess('test-uuid-1234');
    const initSpy = vi.fn();
    const deltaSpy = vi.fn();
    const resultSpy = vi.fn();

    proc.on('init', initSpy);
    proc.on('text_delta', deltaSpy);
    proc.on('result', resultSpy);

    // Call private handleLine via any
    const anyProc = proc as any;
    anyProc.handleLine(JSON.stringify({
      event: 'init',
      conversation_id: 'test-uuid-1234',
      init: { cwd: '/tmp', tools: ['bash'] },
    }));
    expect(initSpy).toHaveBeenCalledWith({ cwd: '/tmp', tools: ['bash'] });

    anyProc.handleLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'test-uuid-1234',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Hello, ',
      },
    }));
    anyProc.handleLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'test-uuid-1234',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'world!',
      },
    }));
    expect(deltaSpy).toHaveBeenCalledTimes(2);
    expect(deltaSpy).toHaveBeenNthCalledWith(1, 'Hello, ');
    expect(deltaSpy).toHaveBeenNthCalledWith(2, 'world!');

    anyProc.handleLine(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'test-uuid-1234',
        status: 'SUCCESS',
        response: 'Hello, world!',
      },
    }));
    expect(resultSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'SUCCESS',
      response: 'Hello, world!',
    }));
  });

  it('should ignore malformed lines without throwing', () => {
    const proc = new AntigravityProcess('test-uuid-1234');
    const anyProc = proc as any;

    expect(() => {
      anyProc.handleLine('some random non-json text');
      anyProc.handleLine('{malformed json');
      anyProc.handleLine('');
    }).not.toThrow();
  });

  it('should fall back to accumulated text when result.response is empty', () => {
    const proc = new AntigravityProcess('test-uuid-empty');
    const anyProc = proc as any;

    let resolvedResult: any = null;
    anyProc.currentTurnResolve = (res: any) => {
      resolvedResult = res;
    };

    anyProc.handleLine(JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'test-uuid-empty',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Accumulated message text',
      },
    }));

    anyProc.handleLine(JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'test-uuid-empty',
        status: 'SUCCESS',
        response: '',
      },
    }));

    expect(resolvedResult).not.toBeNull();
    expect(resolvedResult.response).toBe('Accumulated message text');
  });

  it('should reject active turn immediately on NDJSON error event', () => {
    const proc = new AntigravityProcess('test-uuid-err');
    const anyProc = proc as any;

    let rejectedErr: any = null;
    anyProc.currentTurnReject = (err: any) => {
      rejectedErr = err;
    };

    anyProc.handleLine(JSON.stringify({
      event: 'error',
      error: { message: 'Quota exceeded or CLI crashed' },
    }));

    expect(rejectedErr).not.toBeNull();
    expect(rejectedErr.message).toBe('Quota exceeded or CLI crashed');
  });
});

describe('Antigravity FIFO Turn Queueing', () => {
  let manager: AntigravitySessionManager;

  beforeEach(() => {
    manager = new AntigravitySessionManager({ idleTimeoutMs: 1000 }, 'user');
  });

  afterEach(async () => {
    await manager.disposeAll();
  });

  it('should serialize concurrent turns in strict FIFO order using session.busy', async () => {
    const session = manager.getOrCreateSession('c2c', 'fifo_test_user');
    const proc = manager.getProcess(session);

    const callOrder: string[] = [];

    // Mock sendUserMessage to simulate async turn duration
    vi.spyOn(proc, 'sendUserMessage').mockImplementation((prompt: string) => {
      callOrder.push(`start:${prompt}`);
      return new Promise((resolve) => {
        setTimeout(() => {
          callOrder.push(`end:${prompt}`);
          resolve({
            conversation_id: session.conversationId,
            status: 'SUCCESS',
            response: `Reply to ${prompt}`,
          });
        }, 50);
      });
    });

    // Send 3 concurrent turns
    const p1 = manager.executeTurn('c2c', 'fifo_test_user', undefined, 'Message 1');
    const p2 = manager.executeTurn('c2c', 'fifo_test_user', undefined, 'Message 2');
    const p3 = manager.executeTurn('c2c', 'fifo_test_user', undefined, 'Message 3');

    // Message 1 starts immediately; 2 and 3 are in queue
    expect(session.busy).toBe(true);
    expect(session.queue.length).toBe(2);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe('Reply to Message 1');
    expect(r2).toBe('Reply to Message 2');
    expect(r3).toBe('Reply to Message 3');

    // Verify strict sequential execution
    expect(callOrder).toEqual([
      'start:Message 1',
      'end:Message 1',
      'start:Message 2',
      'end:Message 2',
      'start:Message 3',
      'end:Message 3',
    ]);
    expect(session.busy).toBe(false);
  });

  it('should continue draining queue when a turn throws an error', async () => {
    const session = manager.getOrCreateSession('c2c', 'error_recovery_user');
    const proc = manager.getProcess(session);

    let callCount = 0;
    vi.spyOn(proc, 'sendUserMessage').mockImplementation((prompt: string) => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Turn 1 crashed'));
      }
      return Promise.resolve({
        conversation_id: session.conversationId,
        status: 'SUCCESS',
        response: `Turn 2 succeeded`,
      });
    });

    const p1 = manager.executeTurn('c2c', 'error_recovery_user', undefined, 'Fail message');
    const p2 = manager.executeTurn('c2c', 'error_recovery_user', undefined, 'Success message');

    await expect(p1).rejects.toThrow('Turn 1 crashed');
    const r2 = await p2;
    expect(r2).toBe('Turn 2 succeeded');
    expect(session.busy).toBe(false);
  });
});

describe('Antigravity Media Prompt Integration', () => {
  it('should format multimodal prompt correctly when images are provided', async () => {
    const { buildPromptWithMedia } = await import('./media.ts');
    const prompt = buildPromptWithMedia('这图里有什么？', [
      { localPath: '/tmp/test.png', contentType: 'image/png', filename: 'test.png' }
    ]);
    expect(prompt).toContain('/tmp/test.png');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('这图里有什么？');
  });

  it('should supply default question when user prompt is empty but image exists', async () => {
    const { buildPromptWithMedia } = await import('./media.ts');
    const prompt = buildPromptWithMedia('', [
      { localPath: '/tmp/test2.jpg', contentType: 'image/jpeg', filename: 'test2.jpg' }
    ]);
    expect(prompt).toContain('/tmp/test2.jpg');
    expect(prompt).toContain('请详细查看并描述这张图片的内容');
  });

  it('should return plain text when no media attachments present', async () => {
    const { buildPromptWithMedia } = await import('./media.ts');
    const prompt = buildPromptWithMedia('你好', []);
    expect(prompt).toBe('你好');
  });

  it('should extract local files and sanitize markdown for QQ delivery', async () => {
    const { extractOutboundMedia } = await import('./media.ts');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpFile = path.join(os.tmpdir(), `test_outbound_${Date.now()}.png`);
    fs.writeFileSync(tmpFile, 'dummy data');

    try {
      const sample = `![测试图片](${tmpFile})\n\n🎨 画师：松君sama\n\n[原图文件](file://${tmpFile})`;
      const result = extractOutboundMedia(sample);

      expect(result.filesToSend).toEqual([tmpFile]);
      expect(result.cleanedText).toBe('🎨 画师：松君sama');
      expect(result.cleanedText).not.toContain(tmpFile);
      expect(result.cleanedText).not.toContain('file://');
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });

  it('should never send server source code or markdown documents as outbound files', async () => {
    const { extractOutboundMedia } = await import('./media.ts');
    const path = await import('node:path');

    const sample = '查看详情见文档 [v3.md](file:///home/user/dsh-qqbot/v3.md) 以及代码 [bot.ts](file:///home/user/dsh-qqbot/src/antigravity/bot.ts#L10-L20)。';
    const result = extractOutboundMedia(sample);

    expect(result.filesToSend).toEqual([]);
    expect(result.cleanedText).toBe('查看详情见文档 v3.md 以及代码 bot.ts。');
    expect(result.cleanedText).not.toContain('file://');
    expect(result.cleanedText).not.toContain('/home/user');
  });
});
