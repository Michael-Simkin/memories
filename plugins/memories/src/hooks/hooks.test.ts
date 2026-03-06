import { describe, expect, it, vi } from 'vitest';

import type {
  SessionEndPayload,
  SessionStartPayload,
  StopPayload,
  UserPromptSubmitPayload,
} from './schemas.js';
import { handleSessionEnd } from './session-end.js';
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
    postEngineJsonFn: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

describe('hook handlers', () => {
  it('SessionStart emits systemMessage and additionalContext markdown', async () => {
    const payload: SessionStartPayload = {
      session_id: 'session-abc',
    };
    const appendEventLogFn = vi.fn().mockResolvedValue(undefined);
    const postEngineJsonFn = vi.fn().mockResolvedValue({ ok: true });

    const output = await handleSessionStart(
      payload,
      createSessionStartDependencies({
        appendEventLogFn,
        postEngineJsonFn,
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
    expect(postEngineJsonFn).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 4312 },
      '/sessions/connect',
      { session_id: 'session-abc' },
    );
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

  it('Stop returns immediately and spawns detached worker handoff', async () => {
    const payload: StopPayload = {
      transcript_path: '/tmp/transcript.jsonl',
      session_id: 'session-stop',
    };
    const spawnStopWorkerFn = vi.fn().mockResolvedValue({ pid: 7788 });
    const registerBackgroundHookFn = vi.fn().mockResolvedValue({ active: true, ok: true });
    const finishBackgroundHookFn = vi.fn().mockResolvedValue({ active: false, ok: true });

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
      finishBackgroundHookFn,
      registerBackgroundHookFn,
      resolveEndpointFromLockFn: vi.fn().mockResolvedValue({ host: '127.0.0.1', port: 4322 }),
      spawnStopWorkerFn,
    });

    expect(output).toEqual({ continue: true });
    expect(registerBackgroundHookFn).toHaveBeenCalledTimes(1);
    expect(registerBackgroundHookFn).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 4322 },
      expect.objectContaining({
        detail: 'transcript=/tmp/transcript.jsonl',
        hook_name: 'stop/extraction',
        session_id: 'session-stop',
      }),
    );
    expect(spawnStopWorkerFn).toHaveBeenCalledTimes(1);
    expect(spawnStopWorkerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        background_hook_id: expect.any(String),
        endpoint: { host: '127.0.0.1', port: 4322 },
        transcript_path: '/tmp/transcript.jsonl',
      }),
    );
    expect(finishBackgroundHookFn).not.toHaveBeenCalled();
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
