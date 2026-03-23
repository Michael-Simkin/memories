import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createEngineApp } from '../api/app.js';
import { LOOPBACK_HOST } from '../shared/constants.js';
import { removeLockIfOwned, writeLockMetadata } from '../shared/lockfile.js';
import { logError, logInfo, logWarn } from '../shared/logger.js';
import { ensureGlobalDirectories, resolvePluginRoot } from '../shared/paths.js';

const closeServer = promisify((server: Server, callback: (error?: Error) => void): void => {
  server.close(callback);
});

function resolveSqliteVecPath(pluginRoot: string): string | null {
  const vecPath = path.join(pluginRoot, 'vendor', 'sqlite-vec', `darwin-${os.arch()}`, 'vec0.dylib');
  if (existsSync(vecPath)) {
    return vecPath;
  }
  logWarn('sqlite-vec binary not found; continuing without vec table', { expectedPath: vecPath });
  return null;
}

async function pickPort(): Promise<number> {
  const portFromEnvironment = process.env.MEMORIES_ENGINE_PORT;
  if (portFromEnvironment) {
    const parsed = Number.parseInt(portFromEnvironment.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve an engine port')));
        return;
      }

      const selectedPort = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(selectedPort);
      });
    });
  });
}

async function bootstrap(): Promise<void> {
  const pluginRoot = resolvePluginRoot();
  const globalPaths = await ensureGlobalDirectories();
  const vecExtensionPath = resolveSqliteVecPath(pluginRoot);

  const port = await pickPort();
  const runtime = createEngineApp({
    pluginRoot,
    dbPath: globalPaths.dbPath,
    lockPath: globalPaths.lockPath,
    eventLogPath: globalPaths.eventLogPath,
    port,
    sqliteVecExtensionPath: vecExtensionPath,
    onIdleTimeout: async () => {
      await shutdown('idle-timeout');
    },
    onShutdownRequest: async () => {
      await shutdown('api-request');
    },
  });

  let server: Server | null = null;
  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo('Engine shutting down', { reason });
    if (server) {
      await closeServer(server);
    }
    runtime.close();
    await removeLockIfOwned(globalPaths.lockPath, process.pid);
    process.exit(0);
  }

  server = runtime.app.listen(port, LOOPBACK_HOST, () => {
    void writeLockMetadata(globalPaths.lockPath, {
      host: LOOPBACK_HOST,
      port,
      pid: process.pid,
      started_at: new Date().toISOString(),
    })
      .then(() => {
        logInfo('Engine started', {
          host: LOOPBACK_HOST,
          pid: process.pid,
          port,
        });
      })
      .catch((error) => {
        logError('Failed to write lock metadata', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  process.on('SIGINT', () => {
    void shutdown('sigint').catch((error) => {
      logError('Engine SIGINT shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    void shutdown('sigterm').catch((error) => {
      logError('Engine SIGTERM shutdown failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  });
}

void bootstrap().catch((error) => {
  logError('Engine bootstrap failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
