import { readJsonFromStdin, writeFailOpenOutput, writeHookOutput } from '../shared/hook-io.js';
import { error } from '../shared/logger.js';
import { hookLog } from '../shared/logs.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import {
  postEngineJson,
  resolveEndpointFromLock,
  resolveHookProjectRoot,
  resolveSessionId,
} from './common.js';
import { sessionEndPayloadSchema } from './schemas.js';

async function run(): Promise<void> {
  const payload = (await readJsonFromStdin(sessionEndPayloadSchema)) ?? {};
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await ensureProjectDirectories(projectRoot);

  try {
    const sessionId = await resolveSessionId(payload);
    if (!sessionId) {
      await hookLog(paths.hookLogPath, {
        at: new Date().toISOString(),
        event: 'SessionEnd',
        status: 'skipped',
        detail: 'No session_id could be resolved',
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
