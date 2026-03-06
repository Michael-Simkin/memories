import {
  type HookResult,
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { logError } from '../shared/logger.js';
import { appendEventLog } from '../shared/logs.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import {
  isEngineUnavailableError,
  postEngineJson,
  resolveEndpointFromLock,
  resolveHookProjectRoot,
} from './common.js';
import { type SessionEndPayload,sessionEndPayloadSchema } from './schemas.js';

interface SessionEndDependencies {
  appendEventLogFn: typeof appendEventLog;
  ensureProjectDirectoriesFn: typeof ensureProjectDirectories;
  postEngineJsonFn: typeof postEngineJson;
  resolveEndpointFromLockFn: typeof resolveEndpointFromLock;
}

const defaultDependencies: SessionEndDependencies = {
  appendEventLogFn: appendEventLog,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
  postEngineJsonFn: postEngineJson,
  resolveEndpointFromLockFn: resolveEndpointFromLock,
};

export async function handleSessionEnd(
  payload: SessionEndPayload,
  dependencies: SessionEndDependencies = defaultDependencies,
): Promise<HookResult> {
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await dependencies.ensureProjectDirectoriesFn(projectRoot);

  try {
    const endpoint = await dependencies.resolveEndpointFromLockFn(projectRoot);
    await dependencies.postEngineJsonFn(endpoint, '/sessions/disconnect', {
      session_id: payload.session_id,
    });

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'SessionEnd',
      kind: 'hook',
      status: 'ok',
      session_id: payload.session_id,
    });
    return { continue: true };
  } catch (error) {
    if (isEngineUnavailableError(error)) {
      await dependencies.appendEventLogFn(paths.eventLogPath, {
        at: new Date().toISOString(),
        event: 'SessionEnd',
        kind: 'hook',
        status: 'skipped',
        session_id: payload.session_id,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { continue: true };
    }

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'SessionEnd',
      kind: 'hook',
      status: 'error',
      session_id: payload.session_id,
      detail: error instanceof Error ? error.message : String(error),
    });
    logError('SessionEnd hook failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { continue: true };
  }
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(sessionEndPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleSessionEnd(payload);
  writeHookOutput(output);
}

void run();
