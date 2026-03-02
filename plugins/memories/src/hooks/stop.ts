import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

import { readJsonFromStdin, writeFailOpenOutput, writeHookOutput } from '../shared/hook-io.js';
import { error } from '../shared/logger.js';
import { hookLog } from '../shared/logs.js';
import { ensureProjectDirectories, resolvePluginRoot } from '../shared/paths.js';
import { resolveEndpointFromLock, resolveHookProjectRoot } from './common.js';
import { stopPayloadSchema } from './schemas.js';

interface StopWorkerPayload {
  endpoint: {
    host: string;
    port: number;
  };
  last_assistant_message?: string;
  project_root: string;
  session_id?: string;
  transcript_path: string;
}

function spawnWorker(payload: StopWorkerPayload): void {
  const pluginRoot = resolvePluginRoot();
  const workerEntrypoint = `${pluginRoot}/dist/extraction/run.js`;
  const handoff = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const child = spawn('node', [workerEntrypoint, '--handoff', handoff], {
    detached: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PROJECT_ROOT: payload.project_root,
    },
    stdio: 'ignore',
  });
  child.unref();
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(stopPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }

  const projectRoot = resolveHookProjectRoot(payload);
  const { hookLogPath } = await ensureProjectDirectories(projectRoot);

  try {
    if (payload.stop_hook_active) {
      await hookLog(hookLogPath, {
        at: new Date().toISOString(),
        event: 'Stop',
        status: 'skipped',
        session_id: payload.session_id,
        detail: 'stop_hook_active=true',
      });
      writeHookOutput({ continue: true });
      return;
    }

    await access(payload.transcript_path);
    const endpoint = await resolveEndpointFromLock(projectRoot);

    const workerPayload: StopWorkerPayload = {
      endpoint: { host: endpoint.host, port: endpoint.port },
      project_root: projectRoot,
      transcript_path: payload.transcript_path,
      ...(payload.last_assistant_message
        ? { last_assistant_message: payload.last_assistant_message }
        : {}),
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
    };
    spawnWorker(workerPayload);

    await hookLog(hookLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      status: 'ok',
      session_id: payload.session_id,
      data: { transcript_path: payload.transcript_path },
    });
    writeHookOutput({ continue: true });
  } catch (runError: unknown) {
    await hookLog(hookLogPath, {
      at: new Date().toISOString(),
      event: 'Stop',
      status: 'error',
      session_id: payload.session_id,
      detail: runError instanceof Error ? runError.message : String(runError),
    });
    error('Stop hook failed', {
      error: runError instanceof Error ? runError.message : String(runError),
    });
    writeFailOpenOutput();
  }
}

void run();
