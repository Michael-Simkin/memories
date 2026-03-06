import { mkdir,mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { writeLockMetadata } from '../shared/lockfile.js';
import { createEngineApp } from './app.js';

async function setupRuntime(): Promise<{
  drainCalls: () => number;
  eventLogPath: string;
  lockPath: string;
  runtime: ReturnType<typeof createEngineApp>;
}> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-api-'));
  const memoriesDir = path.join(projectRoot, '.memories');
  await mkdir(memoriesDir, { recursive: true });

  const lockPath = path.join(memoriesDir, 'engine.lock.json');
  const eventLogPath = path.join(memoriesDir, 'ai_memory_events.log');
  await writeLockMetadata(lockPath, {
    host: '127.0.0.1',
    port: 4321,
    pid: process.pid,
    started_at: new Date().toISOString(),
    connected_session_ids: [],
  });

  const previousOllamaUrl = process.env.MEMORIES_OLLAMA_URL;
  process.env.MEMORIES_OLLAMA_URL = '';

  let drainCount = 0;
  const runtime = createEngineApp({
    pluginRoot: process.cwd(),
    projectRoot,
    lockPath,
    eventLogPath,
    port: 4321,
    sqliteVecExtensionPath: null,
    onSessionDrain: async () => {
      drainCount += 1;
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
    drainCalls: () => drainCount,
  };
}

describe('createEngineApp', () => {
  it('serves health and validates session payload errors', async () => {
    const { runtime } = await setupRuntime();
    const api = request(runtime.app);

    await api.get('/health').expect(200).expect(({ body }) => {
      expect(body.ok).toBe(true);
    });

    await api.post('/sessions/connect').send({}).expect(400).expect(({ body }) => {
      expect(body.error.code).toBe('INVALID_SESSION_ID');
      expect(typeof body.error.message).toBe('string');
    });

    await api
      .post('/sessions/connect')
      .send({ session_id: 'session-1' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.active_sessions).toBe(1);
      });

    runtime.close();
  });

  it('supports memory CRUD, search, and unified logs stream', async () => {
    const { runtime } = await setupRuntime();
    const api = request(runtime.app);

    await api.post('/sessions/connect').send({ session_id: 'session-2' }).expect(200);

    const addResponse = await api
      .post('/memories/add')
      .send({
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
        content: 'Runtime baseline is Node 20 or newer.',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.memory.content).toContain('20');
      });

    await api
      .post('/memories/search')
      .send({
        query: 'runtime node',
        limit: 5,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(Array.isArray(body.results)).toBe(true);
        expect(body.meta.source).toBe('hybrid');
      });

    await api.get('/memories').expect(200).expect(({ body }) => {
      expect(body.total).toBe(1);
      expect(body.items).toHaveLength(1);
    });

    await api.delete(`/memories/${memoryId}`).expect(200);

    await api.get('/logs').expect(200).expect(({ body }) => {
      const events = (body.items as Array<{ event: string; kind: string }>).map((item) => item.event);
      const kinds = new Set((body.items as Array<{ event: string; kind: string }>).map((item) => item.kind));

      expect(events).toContain('sessions/connect');
      expect(events).toContain('memory/create');
      expect(kinds.has('hook')).toBe(true);
      expect(kinds.has('operation')).toBe(true);
    });

    runtime.close();
  });

  it('triggers session drain callback exactly once when sessions hit zero', async () => {
    const { runtime, drainCalls } = await setupRuntime();
    const api = request(runtime.app);

    await api.post('/sessions/connect').send({ session_id: 'session-3' }).expect(200);
    await api.post('/sessions/disconnect').send({ session_id: 'session-3' }).expect(200);
    await api.post('/sessions/disconnect').send({ session_id: 'session-3' }).expect(200);

    expect(drainCalls()).toBe(1);
    runtime.close();
  });
});
