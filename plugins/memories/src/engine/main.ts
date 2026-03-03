import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createEngineApp } from '../api/app.js';
import { ENGINE_HOST } from '../shared/constants.js';
import { removeLockIfOwned, writeLockMetadata } from '../shared/lockfile.js';
import { error, info, warn } from '../shared/logger.js';
import {
  ensureProjectDirectories,
  resolvePluginRoot,
  resolveProjectRoot,
} from '../shared/paths.js';

const closeServer = promisify((server: Server, callback: (err?: Error) => void): void => {
  server.close(callback);
});

const SQLITE_VEC_VERSION = '0.1.7-alpha.2';

function vecPlatformPackage(): string {
  return `sqlite-vec-${os.platform()}-${os.arch()}`;
}

function vecExtSuffix(): string {
  if (os.platform() === 'darwin') return '.dylib';
  if (os.platform() === 'win32') return '.dll';
  return '.so';
}

function vecBinaryPath(pluginRoot: string): string {
  return path.join(
    pluginRoot,
    'native',
    'node_modules',
    vecPlatformPackage(),
    `vec0${vecExtSuffix()}`,
  );
}

function vecExtensionPath(pluginRoot: string): string {
  return path.join(pluginRoot, 'native', 'node_modules', vecPlatformPackage(), 'vec0');
}

async function ensureSqliteVec(pluginRoot: string): Promise<string | null> {
  if (existsSync(vecBinaryPath(pluginRoot))) {
    return vecExtensionPath(pluginRoot);
  }

  const pkgSpec = `${vecPlatformPackage()}@${SQLITE_VEC_VERSION}`;
  const prefixDir = path.join(pluginRoot, 'native');

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'npm',
        ['install', '--prefix', prefixDir, pkgSpec],
        { timeout: 30_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`npm install ${pkgSpec} failed: ${stderr || err.message}`));
            return;
          }
          resolve();
        },
      );
    });
  } catch (installError) {
    warn('sqlite-vec install failed; semantic search will use JS fallback', {
      error: installError instanceof Error ? installError.message : String(installError),
    });
    return null;
  }

  if (!existsSync(vecBinaryPath(pluginRoot))) {
    warn('sqlite-vec binary missing after install; using JS fallback');
    return null;
  }

  info('sqlite-vec installed successfully', { package: pkgSpec });
  return vecExtensionPath(pluginRoot);
}

async function pickPort(): Promise<number> {
  const fromEnv = process.env.MEMORIES_ENGINE_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }

  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => reject(err));
    server.listen(0, ENGINE_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate engine port')));
        return;
      }
      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function bootstrap(): Promise<void> {
  const projectRoot = resolveProjectRoot(process.env.PROJECT_ROOT);
  const pluginRoot = resolvePluginRoot();
  const paths = await ensureProjectDirectories(projectRoot);
  const port = await pickPort();
  const vecPath = await ensureSqliteVec(pluginRoot);
  let server: Server | null = null;
  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    info('Engine shutting down', { reason });
    if (server) {
      await closeServer(server);
    }
    await removeLockIfOwned(paths.lockPath, process.pid);
    process.exit(0);
  }

  const runtime = createEngineApp({
    pluginRoot,
    projectRoot,
    lockPath: paths.lockPath,
    operationLogPath: paths.operationLogPath,
    hookLogPath: paths.hookLogPath,
    port,
    vecExtensionPath: vecPath,
    onSessionDrain: async () => {
      await shutdown('session-drain');
    },
  });

  server = runtime.app.listen(port, ENGINE_HOST, () => {
    void writeLockMetadata(paths.lockPath, {
      connected_session_ids: [],
      host: ENGINE_HOST,
      pid: process.pid,
      port,
      started_at: new Date().toISOString(),
    })
      .then(() => {
        info('Engine started', { host: ENGINE_HOST, pid: process.pid, port, projectRoot });
      })
      .catch((lockError: unknown) => {
        error('Failed to write engine lock file', {
          error: lockError instanceof Error ? lockError.message : String(lockError),
        });
      });
  });

  process.on('SIGINT', () => {
    void shutdown('sigint').catch((shutdownError: unknown) => {
      error('Engine failed on SIGINT shutdown', {
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    void shutdown('sigterm').catch((shutdownError: unknown) => {
      error('Engine failed on SIGTERM shutdown', {
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      });
      process.exit(1);
    });
  });
}

void bootstrap().catch((bootstrapError: unknown) => {
  error('Engine bootstrap failed', {
    error: bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError),
  });
  process.exit(1);
});
