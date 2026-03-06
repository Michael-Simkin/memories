import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';

import {
  type HookResult,
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { logError } from '../shared/logger.js';
import { appendEventLog } from '../shared/logs.js';
import { ensureProjectDirectories, resolvePluginRoot } from '../shared/paths.js';
import {
  isEngineUnavailableError,
  postEngineJson,
  resolveEndpointFromLock,
  resolveHookProjectRoot,
} from './common.js';
import { type StopPayload,stopPayloadSchema } from './schemas.js';

const STOP_EXTRACTION_BACKGROUND_HOOK_NAME = 'stop/extraction';

interface StopWorkerHandoff {
  background_hook_id?: string;
  endpoint: {
    host: string;
    port: number;
  };
  project_root: string;
  transcript_path: string;
  last_assistant_message?: string;
  session_id?: string;
}

async function registerBackgroundHook(
  endpoint: { host: string; port: number },
  payload: {
    detail?: string;
    hook_name: string;
    id: string;
    session_id?: string;
  },
): Promise<void> {
  await postEngineJson<typeof payload, { active: boolean; ok: true }>(
    endpoint,
    '/background-hooks/start',
    payload,
  );
}

async function finishBackgroundHook(
  endpoint: { host: string; port: number },
  backgroundHookId: string,
  payload: {
    detail?: string;
    status: 'ok' | 'error' | 'skipped';
  },
): Promise<void> {
  await postEngineJson<typeof payload, { active: boolean; ok: true }>(
    endpoint,
    `/background-hooks/${backgroundHookId}/finish`,
    payload,
  );
}

function spawnStopWorker(handoff: StopWorkerHandoff): Promise<{ pid?: number }> {
  const pluginRoot = resolvePluginRoot();
  const workerEntrypoint = `${pluginRoot}/dist/extraction/run.js`;
  const handoffPayload = Buffer.from(JSON.stringify(handoff), 'utf8').toString('base64');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerEntrypoint, '--handoff', handoffPayload], {
      detached: true,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        PROJECT_ROOT: handoff.project_root,
      },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(typeof child.pid === 'number' ? { pid: child.pid } : {});
    });
  });
}

interface StopHookDependencies {
  accessFn: typeof access;
  appendEventLogFn: typeof appendEventLog;
  ensureProjectDirectoriesFn: typeof ensureProjectDirectories;
  finishBackgroundHookFn: typeof finishBackgroundHook;
  registerBackgroundHookFn: typeof registerBackgroundHook;
  resolveEndpointFromLockFn: typeof resolveEndpointFromLock;
  spawnStopWorkerFn: typeof spawnStopWorker;
}

const defaultDependencies: StopHookDependencies = {
  accessFn: access,
  appendEventLogFn: appendEventLog,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
  finishBackgroundHookFn: finishBackgroundHook,
  registerBackgroundHookFn: registerBackgroundHook,
  resolveEndpointFromLockFn: resolveEndpointFromLock,
  spawnStopWorkerFn: spawnStopWorker,
};

export async function handleStopHook(
  payload: StopPayload,
  dependencies: StopHookDependencies = defaultDependencies,
): Promise<HookResult> {
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await dependencies.ensureProjectDirectoriesFn(projectRoot);

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
    const endpoint = await dependencies.resolveEndpointFromLockFn(projectRoot);
    const backgroundHookId = randomUUID();
    await dependencies.registerBackgroundHookFn(endpoint, {
      id: backgroundHookId,
      hook_name: STOP_EXTRACTION_BACKGROUND_HOOK_NAME,
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: `transcript=${payload.transcript_path}`,
    });

    let spawnedWorker: { pid?: number };
    try {
      spawnedWorker = await dependencies.spawnStopWorkerFn({
        background_hook_id: backgroundHookId,
        endpoint: {
          host: endpoint.host,
          port: endpoint.port,
        },
        project_root: projectRoot,
        transcript_path: payload.transcript_path,
        ...(payload.last_assistant_message
          ? { last_assistant_message: payload.last_assistant_message }
          : {}),
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
      });
    } catch (error) {
      await dependencies.finishBackgroundHookFn(endpoint, backgroundHookId, {
        status: 'error',
        detail: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      kind: 'hook',
      status: 'ok',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: `handoff=${payload.transcript_path}; hook_id=${backgroundHookId}${typeof spawnedWorker.pid === 'number' ? `; pid=${spawnedWorker.pid}` : ''}`,
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
