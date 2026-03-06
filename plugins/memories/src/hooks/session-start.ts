import { ensureEngine } from '../engine/ensure-engine.js';
import {
  type HookResult,
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { logError } from '../shared/logger.js';
import { appendEventLog } from '../shared/logs.js';
import { formatMemoryRecallMarkdown } from '../shared/markdown.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import type { SearchResponse } from '../shared/types.js';
import {
  getEngineJson,
  isEngineUnavailableError,
  postEngineJson,
  resolveHookProjectRoot,
} from './common.js';
import { type SessionStartPayload, sessionStartPayloadSchema } from './schemas.js';

interface SessionStartDependencies {
  appendEventLogFn: typeof appendEventLog;
  ensureEngineFn: typeof ensureEngine;
  ensureProjectDirectoriesFn: typeof ensureProjectDirectories;
  getEngineJsonFn: typeof getEngineJson;
  postEngineJsonFn: typeof postEngineJson;
}

const defaultDependencies: SessionStartDependencies = {
  appendEventLogFn: appendEventLog,
  ensureEngineFn: ensureEngine,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
  getEngineJsonFn: getEngineJson,
  postEngineJsonFn: postEngineJson,
};

function renderStartupMemoryContext(markdown: string): string {
  const indentedMarkdown = markdown
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

  return [
    '<memory>',
    '  <guidance>',
    '    The `recall` tool is your main memory brain for this project.',
    '    REQUIRED: call `recall` before acting. Do not skip.',
    '    Before commands, edits, updates, creations, deletions, or final recommendations, run `recall` to validate the intended action against remembered rules, decisions, preferences, and prior context.',
    '    If the user names a file, path, command, or requested change, treat that as a cue to check memory first. Direct instructions do not override remembered project rules.',
    '    If memory conflicts with the requested action, stop, explain the conflict, and ask or propose a compliant alternative.',
    '    This startup block contains only pinned memories, not the full memory set. Run `recall` whenever broader context or constraints may matter.',
    '  </guidance>',
    '  <pinned_memories>',
    indentedMarkdown,
    '  </pinned_memories>',
    '</memory>',
  ].join('\n');
}

export async function handleSessionStart(
  payload: SessionStartPayload,
  dependencies: SessionStartDependencies = defaultDependencies,
): Promise<HookResult> {
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await dependencies.ensureProjectDirectoriesFn(projectRoot);

  try {
    const endpoint = await dependencies.ensureEngineFn(projectRoot);
    const sessionId = payload.session_id?.trim();
    if (sessionId) {
      await dependencies.postEngineJsonFn(endpoint, '/sessions/connect', { session_id: sessionId });
    }

    const pinned = await dependencies.getEngineJsonFn<SearchResponse>(endpoint, '/memories/pinned');
    const markdown = formatMemoryRecallMarkdown({
      query: 'session-start:pinned',
      results: pinned.results,
      durationMs: pinned.meta.duration_ms,
      source: 'engine:/memories/pinned',
    });
    const memoryUiUrl = `http://${endpoint.host}:${endpoint.port}/ui`;

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'SessionStart',
      kind: 'hook',
      status: 'ok',
      ...(sessionId ? { session_id: sessionId } : {}),
      detail: `ui=${memoryUiUrl}`,
    });

    return {
      continue: true,
      systemMessage: `Memory UI: ${memoryUiUrl}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: renderStartupMemoryContext(markdown),
      },
    };
  } catch (error) {
    if (isEngineUnavailableError(error)) {
      await dependencies.appendEventLogFn(paths.eventLogPath, {
        at: new Date().toISOString(),
        event: 'SessionStart',
        kind: 'hook',
        status: 'skipped',
        detail: error instanceof Error ? error.message : String(error),
      });
      return {
        continue: true,
        systemMessage: 'Memory engine unavailable; continuing without memory context.',
      };
    }

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'SessionStart',
      kind: 'hook',
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
    logError('SessionStart hook failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { continue: true };
  }
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(sessionStartPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleSessionStart(payload);
  writeHookOutput(output);
}

void run();
