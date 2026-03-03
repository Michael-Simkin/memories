import { ensureEngine } from '../engine/ensure-engine.js';
import { readJsonFromStdin, writeFailOpenOutput, writeHookOutput } from '../shared/hook-io.js';
import { error } from '../shared/logger.js';
import { hookLog } from '../shared/logs.js';
import { formatMemoryRecallMarkdown } from '../shared/markdown.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import type { SearchResponse } from '../shared/types.js';
import {
  isEngineUnavailableError,
  isInternalClaudeRun,
  postEngineJson,
  resolveHookProjectRoot,
} from './common.js';
import { sessionStartPayloadSchema } from './schemas.js';

async function run(): Promise<void> {
  const payload = (await readJsonFromStdin(sessionStartPayloadSchema)) ?? {};
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await ensureProjectDirectories(projectRoot);

  if (isInternalClaudeRun()) {
    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'SessionStart',
      status: 'skipped',
      detail: 'internal Claude run; skipping memory hooks',
    });
    writeHookOutput({ continue: true });
    return;
  }

  try {
    const endpoint = await ensureEngine(projectRoot);
    const sessionId = payload.session_id?.trim();
    if (sessionId) {
      await postEngineJson(endpoint, '/sessions/connect', { session_id: sessionId });
    }

    const pinnedResponse = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/pinned`);
    if (!pinnedResponse.ok) {
      throw new Error(`Pinned memory fetch failed: ${pinnedResponse.status} ${pinnedResponse.statusText}`);
    }
    const pinned = (await pinnedResponse.json()) as SearchResponse;

    const markdown = formatMemoryRecallMarkdown({
      query: 'session-start:pinned',
      results: pinned.results,
      durationMs: pinned.meta.duration_ms,
      source: 'engine:/memories/pinned',
    });
    const memoryUiUrl = `http://${endpoint.host}:${endpoint.port}/ui`;

    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'SessionStart',
      status: 'ok',
      ...(sessionId ? { session_id: sessionId } : {}),
      data: { endpoint: `${endpoint.host}:${endpoint.port}` },
    });

    writeHookOutput({
      continue: true,
      systemMessage: `Memory UI: ${memoryUiUrl}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Memory UI: ${memoryUiUrl}\n\n${markdown}`,
      },
    });
  } catch (runError: unknown) {
    if (isEngineUnavailableError(runError)) {
      const detail = runError instanceof Error ? runError.message : String(runError);
      await hookLog(paths.hookLogPath, {
        at: new Date().toISOString(),
        event: 'SessionStart',
        status: 'skipped',
        detail: `engine unavailable; skipping memory injection (${detail})`,
      });
      writeHookOutput({
        continue: true,
        systemMessage: 'Memory engine unavailable; continuing without memory context.',
      });
      return;
    }
    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'SessionStart',
      status: 'error',
      detail: runError instanceof Error ? runError.message : String(runError),
    });
    error('SessionStart hook failed', {
      error: runError instanceof Error ? runError.message : String(runError),
    });
    writeFailOpenOutput();
  }
}

void run();
