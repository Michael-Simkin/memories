import { access } from 'node:fs/promises';

import {
  type HookResult,
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { logError } from '../shared/logger.js';
import { appendEventLog } from '../shared/logs.js';
import { ensureGlobalDirectories } from '../shared/paths.js';
import { resolveRepoId } from '../shared/repo-identity.js';
import {
  isEngineUnavailableError,
  postEngineJson,
  resolveEndpointFromLock,
  resolveHookProjectRoot,
} from './common.js';
import { type StopPayload, stopPayloadSchema } from './schemas.js';

interface StopHookDependencies {
  accessFn: typeof access;
  appendEventLogFn: typeof appendEventLog;
  ensureGlobalDirectoriesFn: typeof ensureGlobalDirectories;
  postEngineJsonFn: typeof postEngineJson;
  resolveEndpointFromLockFn: typeof resolveEndpointFromLock;
  resolveRepoIdFn: typeof resolveRepoId;
}

const defaultDependencies: StopHookDependencies = {
  accessFn: access,
  appendEventLogFn: appendEventLog,
  ensureGlobalDirectoriesFn: ensureGlobalDirectories,
  postEngineJsonFn: postEngineJson,
  resolveEndpointFromLockFn: resolveEndpointFromLock,
  resolveRepoIdFn: resolveRepoId,
};

export async function handleStopHook(
  payload: StopPayload,
  dependencies: StopHookDependencies = defaultDependencies,
): Promise<HookResult> {
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await dependencies.ensureGlobalDirectoriesFn();

  if (payload.stop_hook_active === true) {
    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      kind: 'hook',
      status: 'skipped',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: 'stop_hook_active=true',
    });
    return { continue: true };
  }

  try {
    await dependencies.accessFn(payload.transcript_path);
    const repoId = await dependencies.resolveRepoIdFn(projectRoot);
    const endpoint = await dependencies.resolveEndpointFromLockFn();

    await dependencies.postEngineJsonFn(endpoint, '/extraction/enqueue', {
      transcript_path: payload.transcript_path,
      project_root: projectRoot,
      repo_id: repoId,
      ...(payload.last_assistant_message
        ? { last_assistant_message: payload.last_assistant_message }
        : {}),
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
    });

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      kind: 'hook',
      status: 'ok',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: `enqueued=${payload.transcript_path}; repo_id=${repoId}`,
    });
    return { continue: true };
  } catch (error) {
    if (isEngineUnavailableError(error)) {
      await dependencies.appendEventLogFn(paths.eventLogPath, {
        at: new Date().toISOString(),
        event: 'Stop',
        kind: 'hook',
        status: 'skipped',
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
        detail: error instanceof Error ? error.message : String(error),
      });
      return { continue: true };
    }

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      kind: 'hook',
      status: 'error',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: error instanceof Error ? error.message : String(error),
    });
    logError('Stop hook failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { continue: true };
  }
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(stopPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleStopHook(payload);
  writeHookOutput(output);
}

void run().catch((error) => {
  logError('Stop hook entrypoint failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  writeFailOpenOutput();
});
