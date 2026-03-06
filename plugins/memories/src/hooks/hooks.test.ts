import { describe, expect, it, vi } from 'vitest';

import type { SessionEndPayload, SessionStartPayload, StopPayload } from './schemas.js';
import { handleSessionEnd } from './session-end.js';
import { handleSessionStart } from './session-start.js';
import { handleStopHook } from './stop.js';

describe('hook handlers', () => {
  it('SessionStart emits systemMessage and additionalContext markdown', async () => {
    const payload: SessionStartPayload = {
      session_id: 'session-abc',
    };
    const appendEventLogFn = vi.fn().mockResolvedValue(undefined);
    const postEngineJsonFn = vi.fn().mockResolvedValue({ ok: true });

    const output = await handleSessionStart(payload, {
      appendEventLogFn,
      ensureProjectDirectoriesFn: vi.fn().mockResolvedValue({
        projectRoot: '/tmp',
        memoriesDir: '/tmp/.memories',
        dbPath: '/tmp/.memories/ai_memory.db',
        lockPath: '/tmp/.memories/engine.lock.json',
        eventLogPath: '/tmp/events.log',
      }),
      ensureEngineFn: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 4312 }),
      getEngineJsonFn: vi.fn().mockResolvedValue({
        meta: {
          duration_ms: 3,
          query: 'pinned',
          returned: 1,
          source: 'hybrid',
        },
        results: [
          {
            id: 'memory-1',
            memory_type: 'fact',
            content: 'Pinned memory',
            tags: ['tag'],
            is_pinned: true,
            path_matchers: [],
            score: 1,
            source: 'hybrid',
            updated_at: '2026-03-05T00:00:00.000Z',
          },
        ],
      }),
      postEngineJsonFn,
    });

    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('Memory UI:');
    expect(output.hookSpecificOutput?.additionalContext).toContain('# Memory Recall');
    expect(postEngineJsonFn).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 4312 },
      '/sessions/connect',
      { session_id: 'session-abc' },
    );
  });

  it('Stop returns immediately and spawns detached worker handoff', async () => {
    const payload: StopPayload = {
      transcript_path: '/tmp/transcript.jsonl',
      session_id: 'session-stop',
    };
    const spawnStopWorkerFn = vi.fn();

    const output = await handleStopHook(payload, {
      accessFn: vi.fn().mockResolvedValue(undefined),
      appendEventLogFn: vi.fn().mockResolvedValue(undefined),
      ensureProjectDirectoriesFn: vi.fn().mockResolvedValue({
        projectRoot: '/tmp',
        memoriesDir: '/tmp/.memories',
        dbPath: '/tmp/.memories/ai_memory.db',
        lockPath: '/tmp/.memories/engine.lock.json',
        eventLogPath: '/tmp/events.log',
      }),
      resolveEndpointFromLockFn: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 4322 }),
      spawnStopWorkerFn,
    });

    expect(output).toEqual({ continue: true });
    expect(spawnStopWorkerFn).toHaveBeenCalledTimes(1);
    expect(spawnStopWorkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: { host: '127.0.0.1', port: 4322 },
        transcript_path: '/tmp/transcript.jsonl',
      }),
    );
  });

  it('SessionEnd remains fail-open when disconnect fails', async () => {
    const payload: SessionEndPayload = {
      session_id: 'session-end',
    };

    const output = await handleSessionEnd(payload, {
      appendEventLogFn: vi.fn().mockResolvedValue(undefined),
      ensureProjectDirectoriesFn: vi.fn().mockResolvedValue({
        projectRoot: '/tmp',
        memoriesDir: '/tmp/.memories',
        dbPath: '/tmp/.memories/ai_memory.db',
        lockPath: '/tmp/.memories/engine.lock.json',
        eventLogPath: '/tmp/events.log',
      }),
      postEngineJsonFn: vi.fn().mockRejectedValue(new Error('network failure')),
      resolveEndpointFromLockFn: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 4400 }),
    });

    expect(output).toEqual({ continue: true });
  });
});
