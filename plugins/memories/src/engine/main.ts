import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createEngineApp } from '../api/app.js';
import { LOOPBACK_HOST } from '../shared/constants.js';
import { removeLockIfOwned, writeLockMetadata } from '../shared/lockfile.js';
import { logError, logInfo, logWarn } from '../shared/logger.js';
import { isNativeAbiMismatchError, resolveNativeRuntimeRoot } from '../shared/native-runtime.js';
import { ensureProjectDirectories, resolvePluginRoot, resolveProjectRoot } from '../shared/paths.js';
import { resolveNpmInvocation } from './node-runtime.js';

const SQLITE_VEC_VERSION = '0.1.7-alpha.2';
const NATIVE_INSTALL_TIMEOUT_MS = 120_000;
const requireFromEngine = createRequire(import.meta.url);

const closeServer = promisify((server: Server, callback: (error?: Error) => void): void => {
  server.close(callback);
});

function sqliteVecPackageName(): string {
  return `sqlite-vec-${os.platform()}-${os.arch()}`;
}

function sqliteVecBinaryExtension(): string {
  if (os.platform() === 'darwin') {
    return '.dylib';
  }
  if (os.platform() === 'win32') {
    return '.dll';
  }
  return '.so';
}

function sqliteVecBinaryPath(nativeRoot: string): string {
  return path.join(
    nativeRoot,
    'node_modules',
    sqliteVecPackageName(),
    `vec0${sqliteVecBinaryExtension()}`,
  );
}

function sqliteVecExtensionPath(nativeRoot: string): string {
  return sqliteVecBinaryPath(nativeRoot);
}

function resolvePackage(packageName: string, nativeRoot: string): string | null {
  try {
    return requireFromEngine.resolve(packageName, { paths: [nativeRoot] });
  } catch {
    return null;
  }
}

async function ensureNativeRoot(pluginRoot: string): Promise<string> {
  const nativeRoot = resolveNativeRuntimeRoot(pluginRoot);
  await mkdir(nativeRoot, { recursive: true });

  const packageJsonPath = path.join(nativeRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    await writeFile(
      packageJsonPath,
      `${JSON.stringify({ name: 'memories-native-runtime', private: true }, null, 2)}\n`,
      'utf8',
    );
  }

  return nativeRoot;
}

async function installNativePackage(nativeRoot: string, packageSpec: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const npmInvocation = resolveNpmInvocation(process.execPath);
    execFile(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, 'install', '--prefix', nativeRoot, packageSpec],
      { timeout: NATIVE_INSTALL_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      },
    );
  });
}

async function rebuildNativePackage(nativeRoot: string, packageName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const npmInvocation = resolveNpmInvocation(process.execPath);
    execFile(
      npmInvocation.command,
      [...npmInvocation.argsPrefix, 'rebuild', '--prefix', nativeRoot, packageName],
      { timeout: NATIVE_INSTALL_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve();
      },
    );
  });
}

async function removeNativePackage(nativeRoot: string, packageName: string): Promise<void> {
  await rm(path.join(nativeRoot, 'node_modules', packageName), {
    force: true,
    recursive: true,
  });
}

function verifyBetterSqlite3Load(resolvedPath: string): void {
  try {
    requireFromEngine(resolvedPath);
  } catch (error) {
    throw new Error(
      `better-sqlite3 failed to load from ${resolvedPath}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function ensureBetterSqlite3(nativeRoot: string): Promise<void> {
  if (!resolvePackage('better-sqlite3', nativeRoot)) {
    try {
      await installNativePackage(nativeRoot, 'better-sqlite3');
    } catch (error) {
      throw new Error(
        `Failed to install better-sqlite3 at runtime. Run "npm install --prefix ${nativeRoot} better-sqlite3". ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let resolvedPath = resolvePackage('better-sqlite3', nativeRoot);
  if (!resolvedPath) {
    throw new Error(
      `better-sqlite3 is not resolvable from ${nativeRoot} after installation. Verify native runtime dependencies.`,
    );
  }

  try {
    verifyBetterSqlite3Load(resolvedPath);
  } catch (error) {
    if (!isNativeAbiMismatchError(error)) {
      throw error;
    }

    logWarn('better-sqlite3 ABI mismatch detected; rebuilding runtime dependency', {
      nativeRoot,
      nodeAbi: process.versions.modules,
      nodeVersion: process.versions.node,
      resolvedPath,
    });

    try {
      await rebuildNativePackage(nativeRoot, 'better-sqlite3');
    } catch (rebuildError) {
      logWarn('better-sqlite3 rebuild failed; reinstalling runtime dependency', {
        error: rebuildError instanceof Error ? rebuildError.message : String(rebuildError),
        nativeRoot,
      });

      await removeNativePackage(nativeRoot, 'better-sqlite3');
      try {
        await installNativePackage(nativeRoot, 'better-sqlite3');
      } catch (installError) {
        throw new Error(
          `Failed to reinstall better-sqlite3 at runtime. Run "npm install --prefix ${nativeRoot} better-sqlite3". ${
            installError instanceof Error ? installError.message : String(installError)
          }`,
        );
      }
    }

    resolvedPath = resolvePackage('better-sqlite3', nativeRoot);
    if (!resolvedPath) {
      throw new Error(
        `better-sqlite3 is not resolvable from ${nativeRoot} after rebuild. Verify native runtime dependencies.`,
      );
    }

    verifyBetterSqlite3Load(resolvedPath);
  }
}

async function ensureSqliteVec(nativeRoot: string): Promise<string | null> {
  if (existsSync(sqliteVecBinaryPath(nativeRoot))) {
    return sqliteVecExtensionPath(nativeRoot);
  }

  const packageSpec = `${sqliteVecPackageName()}@${SQLITE_VEC_VERSION}`;
  try {
    await installNativePackage(nativeRoot, packageSpec);
  } catch (error) {
    logWarn('sqlite-vec install failed; continuing with non-vec fallback', {
      error: error instanceof Error ? error.message : String(error),
      packageSpec,
    });
    return null;
  }

  if (!existsSync(sqliteVecBinaryPath(nativeRoot))) {
    logWarn('sqlite-vec binary not found after install; continuing with non-vec fallback', {
      packageSpec,
    });
    return null;
  }

  return sqliteVecExtensionPath(nativeRoot);
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
  const projectRoot = resolveProjectRoot(process.env.PROJECT_ROOT);
  const pluginRoot = resolvePluginRoot();
  const projectPaths = await ensureProjectDirectories(projectRoot);
  const nativeRoot = await ensureNativeRoot(pluginRoot);
  await ensureBetterSqlite3(nativeRoot);
  const vecExtensionPath = await ensureSqliteVec(nativeRoot);

  const port = await pickPort();
  const runtime = createEngineApp({
    pluginRoot,
    projectRoot,
    lockPath: projectPaths.lockPath,
    eventLogPath: projectPaths.eventLogPath,
    port,
    sqliteVecExtensionPath: vecExtensionPath,
    onSessionDrain: async () => {
      await shutdown('session-drain');
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
    await removeLockIfOwned(projectPaths.lockPath, process.pid);
    process.exit(0);
  }

  server = runtime.app.listen(port, LOOPBACK_HOST, () => {
    void writeLockMetadata(projectPaths.lockPath, {
      host: LOOPBACK_HOST,
      port,
      pid: process.pid,
      started_at: new Date().toISOString(),
      connected_session_ids: [],
    })
      .then(() => {
        logInfo('Engine started', {
          host: LOOPBACK_HOST,
          pid: process.pid,
          port,
          projectRoot,
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
