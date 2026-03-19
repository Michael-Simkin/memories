import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { writeLockMetadata } from '../shared/lockfile.js';
import { createEngineApp } from './app.js';

async function waitForTick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function setupRuntimeWithOptions(options?: {
  backgroundHookPolicy?: {
    heartbeatTimeoutMs?: number;
    maxRuntimeMs?: number;
    sweepIntervalMs?: number;
  };
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
}): Promise<{
  idleTimeoutCalls: () => number;
  eventLogPath: string;
  lockPath: string;
  runtime: ReturnType<typeof createEngineApp>;
}> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-api-'));
  const memoriesDir = path.join(projectRoot, '.memories');
  await mkdir(memoriesDir, { recursive: true });

  const dbPath = path.join(memoriesDir, 'ai_memory.db');
  const lockPath = path.join(memoriesDir, 'engine.lock.json');
  const eventLogPath = path.join(memoriesDir, 'ai_memory_events.log');
  await writeLockMetadata(lockPath, {
    host: '127.0.0.1',
    port: 4321,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });

  const previousOllamaUrl = process.env.MEMORIES_OLLAMA_URL;
  process.env.MEMORIES_OLLAMA_URL = '';

  let idleTimeoutCount = 0;
  const runtime = createEngineApp({
    pluginRoot: process.cwd(),
    dbPath,
    lockPath,
    eventLogPath,
    port: 4321,
    sqliteVecExtensionPath: null,
    ...(typeof options?.idleTimeoutMs === 'number' ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(typeof options?.idleCheckIntervalMs === 'number' ? { idleCheckIntervalMs: options.idleCheckIntervalMs } : {}),
    ...(options?.backgroundHookPolicy ? { backgroundHookPolicy: options.backgroundHookPolicy } : {}),
    onIdleTimeout: async () => {
      idleTimeoutCount += 1;
    },
  });

  if (previousOllamaUrl === undefined) {
    delete process.env.MEMORIES_OLLAMA_URL;
  } else {
    process.env.MEMORIES_OLLAMA_URL = previousOllamaUrl;
  }

  return {
    runtime,
    lockPath,
    eventLogPath,
    idleTimeoutCalls: () => idleTimeoutCount,
  };
}

const REPO_ID = 'test-repo-id-0001';

describe('createEngineApp', () => {
  it('serves health endpoint', async () => {
    const { runtime } = await setupRuntimeWithOptions();
    const api = request(runtime.app);

    await api.get('/health').expect(200).expect(({ body }) => {
      expect(body.ok).toBe(true);
    });

    runtime.close();
  });

  it('supports memory CRUD, search, and unified logs stream', async () => {
    const { runtime } = await setupRuntimeWithOptions();
    const api = request(runtime.app);

    const addResponse = await api
      .post('/memories/add')
      .send({
        repo_id: REPO_ID,
        memory_type: 'fact',
        content: 'Runtime baseline is Node 20+.',
        tags: ['runtime', 'node'],
        is_pinned: true,
        path_matchers: [{ path_matcher: 'package.json' }],
      })
      .expect(201);

    const memoryId = addResponse.body.memory.id as string;
    expect(typeof memoryId).toBe('string');

    await api
      .patch(`/memories/${memoryId}`)
      .send({
        repo_id: REPO_ID,
        content: 'Runtime baseline is Node 20 or newer.',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.memory.content).toContain('20');
      });

    await api
      .post('/memories/search')
      .send({
        repo_id: REPO_ID,
        query: 'runtime node',
        limit: 5,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(Array.isArray(body.results)).toBe(true);
        expect(body.meta.source).toBe('hybrid');
      });

    await api.get(`/memories?repo_id=${REPO_ID}`).expect(200).expect(({ body }) => {
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
    });

    await api.delete(`/memories/${memoryId}?repo_id=${REPO_ID}`).expect(200);

    await api.get('/logs').expect(200).expect(({ body }) => {
      const events = (body.items as Array<{ event: string; kind: string }>).map((item) => item.event);
      const kinds = new Set((body.items as Array<{ event: string; kind: string }>).map((item) => item.kind));

      expect(events).toContain('memory/create');
      expect(kinds.has('operation')).toBe(true);
    });

    runtime.close();
  });

  it('triggers idle timeout callback after inactivity', async () => {
    const { runtime, idleTimeoutCalls } = await setupRuntimeWithOptions({
      idleTimeoutMs: 0,
      idleCheckIntervalMs: 10,
    });

    await waitForTick(50);
    expect(idleTimeoutCalls()).toBe(1);
    runtime.close();
  });

  it('returns stats with idle timeout info', async () => {
    const { runtime } = await setupRuntimeWithOptions();
    const api = request(runtime.app);

    await api.get('/stats').expect(200).expect(({ body }) => {
      expect(body.online).toBe(true);
      expect(typeof body.idle_timeout_ms).toBe('number');
      expect(typeof body.idle_remaining_ms).toBe('number');
    });

    runtime.close();
  });

  it('tracks background hooks and blocks idle timeout until they finish', async () => {
    const { runtime, idleTimeoutCalls } = await setupRuntimeWithOptions({
      idleTimeoutMs: 0,
      idleCheckIntervalMs: 10,
    });
    const api = request(runtime.app);

    await api
      .post('/background-hooks/start')
      .send({
        id: 'hook-1',
        hook_name: 'stop/extraction',
        detail: 'transcript=/tmp/transcript.jsonl',
      })
      .expect(201);

    await waitForTick(50);
    expect(idleTimeoutCalls()).toBe(0);

    await api.get('/background-hooks').expect(200).expect(({ body }) => {
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.hook_name).toBe('stop/extraction');
      expect(body.items[0]?.state).toBe('running');
    });

    await api.post('/background-hooks/hook-1/heartbeat').send({ pid: process.pid }).expect(200);
    await api
      .post('/background-hooks/hook-1/finish')
      .send({ status: 'ok', detail: 'completed' })
      .expect(200);

    await waitForTick(50);
    expect(idleTimeoutCalls()).toBe(1);

    await api.get('/background-hooks').expect(200).expect(({ body }) => {
      expect(body.items).toHaveLength(0);
    });

    runtime.close();
  });

  it('expires stale background hooks and triggers idle timeout after cleanup', async () => {
    const { runtime, idleTimeoutCalls } = await setupRuntimeWithOptions({
      backgroundHookPolicy: {
        heartbeatTimeoutMs: 60,
        maxRuntimeMs: 500,
        sweepIntervalMs: 20,
      },
      idleTimeoutMs: 0,
      idleCheckIntervalMs: 10,
    });
    const api = request(runtime.app);

    await api
      .post('/background-hooks/start')
      .send({
        id: 'hook-expire',
        hook_name: 'stop/extraction',
      })
      .expect(201);

    await waitForTick(180);
    expect(idleTimeoutCalls()).toBe(1);

    await api.get('/background-hooks').expect(200).expect(({ body }) => {
      expect(body.items).toHaveLength(0);
    });

    await api.get('/logs').expect(200).expect(({ body }) => {
      const events = (body.items as Array<{ event: string; detail?: string }>).map((item) => item.event);
      expect(events).toContain('background-hook/expire');
    });

    runtime.close();
  });
});
