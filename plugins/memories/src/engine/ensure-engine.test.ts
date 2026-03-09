import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeLockMetadata } from '../shared/lockfile.js';
import { ensureEngine } from './ensure-engine.js';
import { REQUIRED_ENGINE_NODE_MAJOR } from './node-runtime.js';

const originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const originalNodeBin = process.env.MEMORIES_NODE_BIN;
const originalBootTimeout = process.env.MEMORIES_ENGINE_BOOT_TIMEOUT_MS;

afterEach(() => {
  if (originalPluginRoot === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
  }

  if (originalNodeBin === undefined) {
    delete process.env.MEMORIES_NODE_BIN;
  } else {
    process.env.MEMORIES_NODE_BIN = originalNodeBin;
  }

  if (originalBootTimeout === undefined) {
    delete process.env.MEMORIES_ENGINE_BOOT_TIMEOUT_MS;
  } else {
    process.env.MEMORIES_ENGINE_BOOT_TIMEOUT_MS = originalBootTimeout;
  }
});

async function createProjectRoot(): Promise<{ lockPath: string; projectRoot: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-engine-'));
  const memoriesPath = path.join(projectRoot, '.memories');
  await mkdir(memoriesPath, { recursive: true });
  return {
    lockPath: path.join(memoriesPath, 'engine.lock.json'),
    projectRoot,
  };
}

async function createPluginRootWithEngineEntrypoint(contents: string): Promise<string> {
  const pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-plugin-'));
  const engineDirectory = path.join(pluginRoot, 'dist', 'engine');
  await mkdir(engineDirectory, { recursive: true });
  await writeFile(path.join(engineDirectory, 'main.js'), contents, 'utf8');
  return pluginRoot;
}

async function createHealthServer(): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected numeric port from health server');
  }

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    port: address.port,
  };
}

describe('ensureEngine', () => {
  it('reuses a healthy lock endpoint when pid is alive', async () => {
    const { projectRoot, lockPath } = await createProjectRoot();
    const healthServer = await createHealthServer();
    process.env.CLAUDE_PLUGIN_ROOT = projectRoot;

    await writeLockMetadata(lockPath, {
      host: '127.0.0.1',
      port: healthServer.port,
      pid: process.pid,
      started_at: new Date().toISOString(),
      connected_session_ids: [],
    });

    const endpoint = await ensureEngine(projectRoot);
    expect(endpoint).toEqual({
      host: '127.0.0.1',
      port: healthServer.port,
    });

    await healthServer.close();
  });

  it('cleans stale lock when pid is dead before spawn path', async () => {
    const { projectRoot, lockPath } = await createProjectRoot();
    process.env.CLAUDE_PLUGIN_ROOT = projectRoot;

    await writeLockMetadata(lockPath, {
      host: '127.0.0.1',
      port: 4100,
      pid: 999_999_999,
      started_at: new Date().toISOString(),
      connected_session_ids: [],
    });

    await expect(ensureEngine(projectRoot)).rejects.toThrow('Engine entrypoint missing');
    await expect(access(lockPath)).rejects.toThrow();
  });

  it('does not trust non-loopback lock host entries', async () => {
    const { projectRoot, lockPath } = await createProjectRoot();
    process.env.CLAUDE_PLUGIN_ROOT = projectRoot;

    await writeFile(
      lockPath,
      JSON.stringify({
        host: '192.168.0.8',
        port: 4444,
        pid: process.pid,
        started_at: new Date().toISOString(),
        connected_session_ids: [],
      }),
      'utf8',
    );

    await expect(ensureEngine(projectRoot)).rejects.toThrow('Engine entrypoint missing');
  });

  it('fails fast when the spawned engine exits before becoming healthy', async () => {
    const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
    if (!Number.isFinite(currentNodeMajor) || currentNodeMajor < REQUIRED_ENGINE_NODE_MAJOR) {
      return;
    }

    const { projectRoot } = await createProjectRoot();
    const pluginRoot = await createPluginRootWithEngineEntrypoint(
      [
        "process.stderr.write(JSON.stringify({ message: 'Engine bootstrap failed', data: { error: 'boom' } }) + '\\n');",
        'process.exit(1);',
      ].join('\n'),
    );
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    process.env.MEMORIES_NODE_BIN = process.execPath;
    process.env.MEMORIES_ENGINE_BOOT_TIMEOUT_MS = '30000';

    const startedAt = Date.now();
    await expect(ensureEngine(projectRoot)).rejects.toThrow(
      /Engine process exited before becoming healthy.*Engine bootstrap failed: boom/i,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
