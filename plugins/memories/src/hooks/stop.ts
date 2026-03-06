import { spawn } from 'node:child_process';
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
import { isEngineUnavailableError, resolveEndpointFromLock, resolveHookProjectRoot } from './common.js';
import { type StopPayload,stopPayloadSchema } from './schemas.js';

interface StopWorkerHandoff {
  endpoint: {
    host: string;
    port: number;
  };
  project_root: string;
  transcript_path: string;
  last_assistant_message?: string;
  session_id?: string;
}

function spawnStopWorker(handoff: StopWorkerHandoff): void {
  const pluginRoot = resolvePluginRoot();
  const workerEntrypoint = `${pluginRoot}/dist/extraction/run.js`;
  const handoffPayload = Buffer.from(JSON.stringify(handoff), 'utf8').toString('base64');

  const child = spawn(process.execPath, [workerEntrypoint, '--handoff', handoffPayload], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: handoff.project_root,
    },
    stdio: 'ignore',
  });
  child.once('error', (error) => {
    logError('Failed to spawn stop extraction worker', {
      error: error.message,
      workerEntrypoint,
    });
  });
  child.unref();
}

interface StopHookDependencies {
  accessFn: typeof access;
  appendEventLogFn: typeof appendEventLog;
  ensureProjectDirectoriesFn: typeof ensureProjectDirectories;
  resolveEndpointFromLockFn: typeof resolveEndpointFromLock;
  spawnStopWorkerFn: typeof spawnStopWorker;
}

const defaultDependencies: StopHookDependencies = {
  accessFn: access,
  appendEventLogFn: appendEventLog,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
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
    dependencies.spawnStopWorkerFn({
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

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      kind: 'hook',
      status: 'ok',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: `handoff=${payload.transcript_path}`,
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

void run();
