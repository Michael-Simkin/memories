import { describe, expect, it, vi } from 'vitest';

import type { WorkerPayload } from './contracts.js';
import { buildClaudeProcessEnv, CONFIDENCE_THRESHOLD, executeWorker } from './run.js';

function createPayload(): WorkerPayload {
  return {
    endpoint: { host: '127.0.0.1', port: 4301 },
    project_root: '/tmp/project',
    repo_id: 'test-repo-id-0001',
    transcript_path: '/tmp/project/transcript.jsonl',
    session_id: 'session-1',
    last_assistant_message: 'remember important project constraints',
  };
}

function createDependencies(options: {
  applyActionFn?: typeof executeWorker extends (
    payload: WorkerPayload,
    dependencies: infer TDeps,
  ) => Promise<void>
    ? TDeps extends { applyActionFn: infer TApplyFn }
      ? TApplyFn
      : never
    : never;
  runClaudeStdout: string;
}): {
  appendEventLogFn: ReturnType<typeof vi.fn>;
  dependencies: Parameters<typeof executeWorker>[1];
  runClaudeFn: ReturnType<typeof vi.fn>;
} {
  const appendEventLogFn = vi.fn().mockResolvedValue(undefined);
  const applyActionFn =
    options.applyActionFn ??
    vi.fn().mockResolvedValue({
      ok: true,
    });
  const runClaudeFn = vi.fn().mockResolvedValue({
    code: 0,
    stderr: '',
    stdout: options.runClaudeStdout,
  });

  const dependencies = {
    appendEventLogFn,
    applyActionFn,
    readTranscriptContextFn: vi.fn().mockResolvedValue({
      transcriptSnippet: 'snippet',
      relatedPaths: ['src/app.ts'],
    }),
    runClaudeFn,
    searchCandidatesFn: vi.fn().mockResolvedValue({
      meta: {
        duration_ms: 2,
        query: 'remember',
        returned: 0,
        source: 'hybrid',
      },
      results: [],
    }),
  } as Parameters<typeof executeWorker>[1];

  return {
    appendEventLogFn,
    dependencies,
    runClaudeFn,
  };
}

describe('extraction worker', () => {
  it('applies only high-confidence actions and skips low-confidence ones', async () => {
    const payload = createPayload();
    const applyActionFn = vi.fn().mockResolvedValue({ ok: true });
    const { dependencies } = createDependencies({
      applyActionFn,
      runClaudeStdout: JSON.stringify({
        actions: [
          {
            action: 'create',
            confidence: 0.9,
            memory_type: 'fact',
            content: 'Node 20 baseline',
            tags: ['runtime'],
            is_pinned: true,
            path_matchers: [{ path_matcher: 'src/app.ts' }],
          },
          {
            action: 'create',
            confidence: 0.2,
            memory_type: 'fact',
            content: 'low confidence candidate',
            tags: [],
            is_pinned: false,
            path_matchers: [],
          },
        ],
      }),
    });

    await executeWorker(payload, dependencies);
    expect(applyActionFn).toHaveBeenCalledTimes(1);
    expect(CONFIDENCE_THRESHOLD).toBe(0.75);
  });

  it('fails safe on invalid Claude output JSON', async () => {
    const payload = createPayload();
    const applyActionFn = vi.fn().mockResolvedValue({ ok: true });
    const { appendEventLogFn, dependencies } = createDependencies({
      applyActionFn,
      runClaudeStdout: 'this is not json',
    });

    await executeWorker(payload, dependencies);
    expect(applyActionFn).not.toHaveBeenCalled();

    const events = appendEventLogFn.mock.calls.map((call) => call[1]?.event);
    expect(events).toContain('extraction/claude-response');
    expect(events).toContain('extraction/parse');
    expect(events).toContain('extraction/error');

    const parseEvent = appendEventLogFn.mock.calls
      .map((call) => call[1])
      .find((event) => event?.event === 'extraction/parse');
    expect(parseEvent?.data).toMatchObject({
      parser_debug: {
        parser_stage: 'top-level',
      },
    });
  });

  it('stops on first write failure', async () => {
    const payload = createPayload();
    const applyActionFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'HTTP_500', message: 'server error' })
      .mockResolvedValueOnce({ ok: true });
    const { appendEventLogFn, dependencies } = createDependencies({
      applyActionFn,
      runClaudeStdout: JSON.stringify({
        actions: [
          {
            action: 'create',
            confidence: 0.95,
            memory_type: 'fact',
            content: 'first action',
            tags: [],
            is_pinned: false,
            path_matchers: [],
          },
          {
            action: 'delete',
            confidence: 0.95,
            memory_id: 'mem-2',
          },
        ],
      }),
    });

    await executeWorker(payload, dependencies);
    expect(applyActionFn).toHaveBeenCalledTimes(1);

    const completionEvent = appendEventLogFn.mock.calls
      .map((call) => call[1])
      .find((event) => event?.event === 'extraction/complete');
    expect(completionEvent?.status).toBe('error');
  });

  it('logs field-level validation issues for malformed actions payload', async () => {
    const payload = createPayload();
    const applyActionFn = vi.fn().mockResolvedValue({ ok: true });
    const { appendEventLogFn, dependencies } = createDependencies({
      applyActionFn,
      runClaudeStdout: JSON.stringify({
        actions: [
          {
            action: 'create',
            confidence: 0.95,
            content: 'missing required memory_type',
            tags: ['test'],
          },
        ],
      }),
    });

    await executeWorker(payload, dependencies);
    expect(applyActionFn).not.toHaveBeenCalled();

    const parseEvent = appendEventLogFn.mock.calls
      .map((call) => call[1])
      .find((event) => event?.event === 'extraction/parse');

    const issues = (parseEvent?.data as { validation_issues?: Array<{ path: string }> })?.validation_issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues?.some((issue) => issue.path.includes('memory_type'))).toBe(true);
  });

  it('injects CLAUDE_CODE_SIMPLE into Claude subprocess env', () => {
    const env = buildClaudeProcessEnv({ PATH: '/usr/bin' });
    expect(env.CLAUDE_CODE_SIMPLE).toBe('1');
  });

  it('instructs Claude to pin only durable project-wide memories', async () => {
    const payload = createPayload();
    const { dependencies, runClaudeFn } = createDependencies({
      runClaudeStdout: JSON.stringify({
        actions: [{ action: 'skip', confidence: 1, reason: 'nothing durable to store' }],
      }),
    });

    await executeWorker(payload, dependencies);

    const prompt = runClaudeFn.mock.calls[0]?.[0];
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Pinning rules:');
    expect(prompt).toContain('set is_pinned=true only when the memory should be injected at SessionStart');
    expect(prompt).toContain('prefer pinning stable rules, architectural decisions');
    expect(prompt).toContain('keep is_pinned=false for transient facts, narrow file-specific context');
    expect(prompt).toContain('if uncertain, default to is_pinned=false');
    expect(prompt).toContain("only change an existing memory's is_pinned state");
  });
});
