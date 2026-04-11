import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';

import { readJsonFromStdin, writeFailOpenOutput, writeHookOutput } from '../shared/hook-io.js';
import { isSyncRunning } from '../shared/lockfile.js';
import { logError, logInfo } from '../shared/logger.js';
import { resolveNode24Runtime } from '../shared/node-runtime.js';
import { ensureGlobalDirectories, resolvePluginRoot } from '../shared/paths.js';
import { sessionEndPayloadSchema } from '../shared/types.js';

async function handleSessionEnd(): Promise<void> {
  const paths = await ensureGlobalDirectories();

  const running = await isSyncRunning(paths.syncLockPath);
  if (running) {
    logInfo('Sync already running, skipping');
    writeHookOutput({ continue: true });
    return;
  }

  try {
    const runtime = await resolveNode24Runtime();
    const pluginRoot = resolvePluginRoot();
    const runnerScript = path.join(pluginRoot, 'dist', 'sync', 'runner.js');

    const stderrFd = openSync(paths.syncStderrPath, 'a');

    const child = spawn(runtime.executable, [runnerScript], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd],
      env: { ...process.env },
    });
    child.unref();

    logInfo('Spawned sync runner', { pid: child.pid, node: runtime.executable });
  } catch (error) {
    logError('Failed to spawn sync runner', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  writeHookOutput({ continue: true });
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(sessionEndPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  await handleSessionEnd();
}

void run().catch((error) => {
  logError('SessionEnd hook failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  writeFailOpenOutput();
});
