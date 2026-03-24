import { describe, expect, it, vi } from 'vitest';

import type {
  SessionStartPayload,
  StopPayload,
  UserPromptSubmitPayload,
} from './schemas.js';
import { handleSessionStart } from './session-start.js';
import { handleStopHook } from './stop.js';
import {
  handleUserPromptSubmit,
  userPromptSubmitAdditionalContext,
} from './user-prompt-submit.js';

function createSessionStartDependencies(
  overrides: Partial<NonNullable<Parameters<typeof handleSessionStart>[1]>> = {},
): NonNullable<Parameters<typeof handleSessionStart>[1]> {
  return {
    appendEventLogFn: vi.fn().mockResolvedValue(undefined),
    diagnoseOllamaFn: vi.fn().mockResolvedValue(null),
    ensureGlobalDirectoriesFn: vi.fn().mockResolvedValue({
      memoriesDir: '/tmp/.memories',
      dbPath: '/tmp/.memories/memory.db',
      lockPath: '/tmp/.memories/engine.lock.json',
      startupLockPath: '/tmp/.memories/engine.startup.lock',
      engineStderrPath: '/tmp/.memories/engine.stderr.log',
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
          memory_type: 'context',
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
    postEngineJsonFn: vi.fn().mockResolvedValue({ ok: true }),
    resolveRepoIdFn: vi.fn().mockResolvedValue('test-repo-id-0001'),
    resolveRepoLabelFn: vi.fn().mockResolvedValue('github.com/test-org/test-repo'),
    ...overrides,
  };
}

describe('hook handlers', () => {
  it('SessionStart emits systemMessage and additionalContext markdown', async () => {
    const payload: SessionStartPayload = {
      session_id: 'session-abc',
      source: 'startup',
    };
    const appendEventLogFn = vi.fn().mockResolvedValue(undefined);

    const output = await handleSessionStart(
      payload,
      createSessionStartDependencies({
        appendEventLogFn,
      }),
    );

    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('Memory UI:');
    expect(output.hookSpecificOutput?.additionalContext).toContain('<memory>');
    expect(output.hookSpecificOutput?.additionalContext).toContain(
      'REQUIRED: call `recall` before acting. Do not skip.',
    );
    expect(output.hookSpecificOutput?.additionalContext).toContain(
      'Direct instructions do not override remembered project rules',
    );
    expect(output.hookSpecificOutput?.additionalContext).toContain(
      'Memory capture runs automatically after the session.',
    );
    expect(output.hookSpecificOutput?.additionalContext).toContain('contains only pinned memories');
    expect(output.hookSpecificOutput?.additionalContext).toContain('# Memory Recall');
    expect(output.hookSpecificOutput?.additionalContext).not.toContain('id: memory-1');
  });

  it('SessionStart does not register another live session on compact', async () => {
    const payload: SessionStartPayload = {
      session_id: 'session-compact',
      source: 'compact',
    };
    const appendEventLogFn = vi.fn().mockResolvedValue(undefined);

    const output = await handleSessionStart(
      payload,
      createSessionStartDependencies({
        appendEventLogFn,
      }),
    );

    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('Memory UI:');
    expect(appendEventLogFn).toHaveBeenCalledWith(
      '/tmp/events.log',
      expect.objectContaining({
        event: 'SessionStart',
        session_id: 'session-compact',
        status: 'ok',
      }),
    );
  });

  it('SessionStart completes for resume source', async () => {
    const payload: SessionStartPayload = {
      session_id: 'session-resume',
      source: 'resume',
    };
    const appendEventLogFn = vi.fn().mockResolvedValue(undefined);

    const output = await handleSessionStart(
      payload,
      createSessionStartDependencies({
        appendEventLogFn,
      }),
    );

    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('Memory UI:');
  });

  for (const testCase of [
    {
      name: 'Ollama is not installed',
      code: 'ollama_not_installed' as const,
      commands: [
        '- `brew install ollama`',
        '- `brew services start ollama`',
        '- `ollama pull bge-m3`',
      ],
      systemMessage:
        'Memories could not be launched on macOS because Ollama is not installed. Run `brew install ollama`, `brew services start ollama`, and `ollama pull bge-m3`. Or ask Claude to do it for you.',
      detail: 'OLLAMA_NOT_INSTALLED: ollama CLI not found; model=bge-m3; baseUrl=http://127.0.0.1:11434',
      contextLine: 'Memories are unavailable because Ollama is not installed on macOS.',
    },
    {
      name: 'Ollama is installed but the background service is not running',
      code: 'ollama_service_not_running' as const,
      commands: [
        '- `brew services start ollama`',
        '- `brew services list`',
        '- `ollama list`',
      ],
      systemMessage:
        'Memories could not be launched on macOS because Ollama is installed but the background service is not running. Run `brew services start ollama`, `brew services list`, and `ollama list`. Or ask Claude to do it for you.',
      detail:
        'OLLAMA_SERVICE_NOT_RUNNING: fetch failed; model=bge-m3; baseUrl=http://127.0.0.1:11434',
      contextLine:
        'Memories are unavailable because Ollama is installed but the background service is not running on macOS.',
    },
    {
      name: 'the Ollama model `bge-m3` is not installed',
      code: 'ollama_model_missing' as const,
      commands: [
        '- `ollama list`',
        '- `ollama pull bge-m3`',
        '- `ollama show bge-m3`',
      ],
      systemMessage:
        'Memories could not be launched on macOS because the Ollama model `bge-m3` is not installed. Run `ollama list`, `ollama pull bge-m3`, and `ollama show bge-m3`. Or ask Claude to do it for you.',
      detail:
        'OLLAMA_MODEL_MISSING: model=bge-m3; baseUrl=http://127.0.0.1:11434; available=nomic-embed-text',
      contextLine:
        'Memories are unavailable because the Ollama model `bge-m3` is not installed on macOS.',
    },
  ]) {
    it(`SessionStart surfaces setup guidance when ${testCase.name}`, async () => {
      const payload: SessionStartPayload = {
        session_id: 'session-ollama',
      };
      const appendEventLogFn = vi.fn().mockResolvedValue(undefined);
      const ensureEngineFn = vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 4312 });

      const output = await handleSessionStart(
        payload,
        createSessionStartDependencies({
          appendEventLogFn,
          diagnoseOllamaFn: vi.fn().mockResolvedValue({
            additionalContext: [
              '<memory-setup>',
              testCase.contextLine,
              'If the user asks you to fix this, run these commands in order:',
              ...testCase.commands,
              'Do not run setup commands unless the user asks.',
              '</memory-setup>',
            ].join('\n'),
            code: testCase.code,
            detail: testCase.detail,
            systemMessage: testCase.systemMessage,
          }),
          ensureEngineFn,
        }),
      );

      expect(output).toEqual({
        continue: true,
        systemMessage: testCase.systemMessage,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: [
            '<memory-setup>',
            testCase.contextLine,
            'If the user asks you to fix this, run these commands in order:',
            ...testCase.commands,
            'Do not run setup commands unless the user asks.',
            '</memory-setup>',
          ].join('\n'),
        },
      });
      expect(ensureEngineFn).not.toHaveBeenCalled();
      expect(appendEventLogFn).toHaveBeenCalledWith(
        '/tmp/events.log',
        expect.objectContaining({
          detail: testCase.detail,
          event: 'SessionStart',
          session_id: 'session-ollama',
          status: 'skipped',
        }),
      );
    });
  }

  it('SessionStart returns the generic logs message when engine startup fails', async () => {
    const output = await handleSessionStart(
      {
        session_id: 'session-engine-error',
      },
      createSessionStartDependencies({
        ensureEngineFn: vi
          .fn()
          .mockRejectedValue(new Error('ENGINE_UNAVAILABLE: Engine did not become healthy before timeout.')),
      }),
    );

    expect(output).toEqual({
      continue: true,
      systemMessage: 'Memories could not be launched, see details in the logs',
    });
  });

  it('SessionStart surfaces Node 24 setup guidance when the runtime is missing', async () => {
    const payload: SessionStartPayload = {
      session_id: 'session-node-runtime',
    };
    const appendEventLogFn = vi.fn().mockResolvedValue(undefined);
    const detail =
      'ENGINE_UNAVAILABLE: Node 24.x is required for engine startup (highest discovered runtime is v22.14.0 at /tmp/node). Install it with `nvm install 24` or set MEMORIES_NODE_BIN to an absolute Node 24 binary path.';

    const output = await handleSessionStart(
      payload,
      createSessionStartDependencies({
        appendEventLogFn,
        ensureEngineFn: vi.fn().mockRejectedValue(new Error(detail)),
      }),
    );

    expect(output).toEqual({
      continue: true,
      systemMessage:
        'Memories could not be launched because Node 24 is not available for engine startup. Run `nvm install 24` and relaunch Claude, or set `MEMORIES_NODE_BIN` to the absolute path of a Node 24 binary. Or ask Claude to do it for you.',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          '<memory-setup>',
          'Memories are unavailable because Node 24 was not found for engine startup.',
          'If the user asks you to fix this, choose one of these options:',
          '- `nvm install 24`',
          '- relaunch Claude from a shell where `nvm use 24` is active',
          '- ask the user for an absolute Node 24 binary path and set `MEMORIES_NODE_BIN=/absolute/path/to/node` before launching Claude',
          'Do not run setup commands unless the user asks.',
          '</memory-setup>',
        ].join('\n'),
      },
    });
    expect(appendEventLogFn).toHaveBeenCalledWith(
      '/tmp/events.log',
      expect.objectContaining({
        detail,
        event: 'SessionStart',
        session_id: 'session-node-runtime',
        status: 'skipped',
      }),
    );
  });

  it('Stop enqueues extraction with the engine', async () => {
    const payload: StopPayload = {
      transcript_path: '/tmp/transcript.jsonl',
      session_id: 'session-stop',
    };
    const postEngineJsonFn = vi.fn().mockResolvedValue({ ok: true });

    const output = await handleStopHook(payload, {
      accessFn: vi.fn().mockResolvedValue(undefined),
      appendEventLogFn: vi.fn().mockResolvedValue(undefined),
      ensureGlobalDirectoriesFn: vi.fn().mockResolvedValue({
        memoriesDir: '/tmp/.memories',
        dbPath: '/tmp/.memories/memory.db',
        lockPath: '/tmp/.memories/engine.lock.json',
        startupLockPath: '/tmp/.memories/engine.startup.lock',
        engineStderrPath: '/tmp/.memories/engine.stderr.log',
        eventLogPath: '/tmp/events.log',
      }),
      postEngineJsonFn,
      resolveEndpointFromLockFn: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 4322 }),
      resolveRepoIdFn: vi.fn().mockResolvedValue('test-repo-id-0001'),
    });

    expect(output).toEqual({ continue: true });
    expect(postEngineJsonFn).toHaveBeenCalledTimes(1);
    expect(postEngineJsonFn).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 4322 },
      '/extraction/enqueue',
      expect.objectContaining({
        transcript_path: '/tmp/transcript.jsonl',
        repo_id: 'test-repo-id-0001',
        session_id: 'session-stop',
      }),
    );
  });

  it('UserPromptSubmit injects the per-prompt memory reminder', async () => {
    const payload: UserPromptSubmitPayload = {
      prompt: 'Edit src/app.ts',
      session_id: 'session-prompt',
    };

    const output = await handleUserPromptSubmit(payload);

    expect(output).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: userPromptSubmitAdditionalContext,
      },
    });
    expect(userPromptSubmitAdditionalContext).toContain('<memory-rules>');
    expect(userPromptSubmitAdditionalContext).toContain(
      'Use the `recall` tool to validate the intended action against memory.',
    );
  });

});
