import { mkdir,mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeLockMetadata } from '../shared/lockfile.js';
import { recallInvocationPolicyText, runRecall } from './search-server.js';

const originalTimeout = process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) {
    delete process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS;
  } else {
    process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS = originalTimeout;
  }
});

async function createProjectRootWithLock(port: number): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-mcp-'));
  const memoriesDir = path.join(projectRoot, '.memories');
  await mkdir(memoriesDir, { recursive: true });

  await writeLockMetadata(path.join(memoriesDir, 'engine.lock.json'), {
    host: '127.0.0.1',
    port,
    pid: process.pid,
    started_at: new Date().toISOString(),
    connected_session_ids: [],
  });
  return projectRoot;
}

async function startEngineServer(): Promise<{ close: () => Promise<void>; port: number }> {
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/memories/search') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          meta: {
            query: 'runtime',
            returned: 1,
            duration_ms: 3,
            source: 'hybrid',
          },
          results: [
            {
              id: 'mem-1',
              memory_type: 'fact',
              content: 'Use Node 20+',
              tags: ['runtime'],
              is_pinned: true,
              path_matchers: ['package.json'],
              score: 0.9,
              source: 'hybrid',
              updated_at: '2026-03-05T00:00:00.000Z',
            },
          ],
        }),
      );
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected numeric server address');
  }

  return {
    port: address.port,
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
  };
}

describe('MCP recall server', () => {
  it('returns canonical markdown for valid recall request', async () => {
    const engineServer = await startEngineServer();
    const projectRoot = await createProjectRootWithLock(engineServer.port);

    const markdown = await runRecall({
      query: 'runtime',
      project_root: projectRoot,
    });

    expect(markdown).toContain('# Memory Recall');
    expect(markdown).toContain('Use Node 20+');
    await engineServer.close();
  });

  it('returns validation errors for invalid payloads', async () => {
    await expect(
      runRecall({
        query: '',
      }),
    ).rejects.toThrow();
  });

  it('times out cleanly when engine endpoint is unreachable', async () => {
    process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS = '20';
    const projectRoot = await createProjectRootWithLock(65099);

    await expect(
      runRecall({
        query: 'runtime',
        project_root: projectRoot,
      }),
    ).rejects.toThrow('ENGINE_CALL_FAILED');
  });

  it('contains required invocation policy guidance text', () => {
    expect(recallInvocationPolicyText).toContain('Main memory brain');
    expect(recallInvocationPolicyText).toContain('REQUIRED: call recall before acting');
    expect(recallInvocationPolicyText).toContain('do not skip');
    expect(recallInvocationPolicyText).toContain('direct instructions do not');
    expect(recallInvocationPolicyText).toContain('file, path, command, or requested change');
  });
});
