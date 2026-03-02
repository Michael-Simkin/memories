import { readJsonFromStdin, writeFailOpenOutput, writeHookOutput } from '../shared/hook-io.js';
import { error } from '../shared/logger.js';
import { hookLog } from '../shared/logs.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import {
  isEngineUnavailableError,
  isInternalClaudeRun,
  postEngineJson,
  resolveEndpointFromLock,
  resolveHookProjectRoot,
} from './common.js';
import { sessionEndPayloadSchema } from './schemas.js';

async function run(): Promise<void> {
  const payload = (await readJsonFromStdin(sessionEndPayloadSchema)) ?? {};
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await ensureProjectDirectories(projectRoot);

  if (isInternalClaudeRun()) {
    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'SessionEnd',
      status: 'skipped',
      detail: 'internal Claude run; skipping memory hooks',
    });
    writeHookOutput({ continue: true });
    return;
  }

  try {
    const sessionId = payload.session_id?.trim();
    if (!sessionId) {
      await hookLog(paths.hookLogPath, {
        at: new Date().toISOString(),
        event: 'SessionEnd',
        status: 'skipped',
        detail: 'No session_id in payload',
      });
      writeHookOutput({ continue: true });
      return;
    }

    const endpoint = await resolveEndpointFromLock(projectRoot);
    await postEngineJson(endpoint, '/sessions/disconnect', { session_id: sessionId });
    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'SessionEnd',
      status: 'ok',
      session_id: sessionId,
    });

    writeHookOutput({ continue: true });
  } catch (runError: unknown) {
    if (isEngineUnavailableError(runError)) {
      await hookLog(paths.hookLogPath, {
        at: new Date().toISOString(),
        event: 'SessionEnd',
        status: 'skipped',
        detail: 'engine not running; skipping session disconnect',
      });
      writeHookOutput({ continue: true });
      return;
    }
    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'SessionEnd',
      status: 'error',
      detail: runError instanceof Error ? runError.message : String(runError),
    });
    error('SessionEnd hook failed', {
      error: runError instanceof Error ? runError.message : String(runError),
    });
    writeFailOpenOutput();
  }
}

void run();
