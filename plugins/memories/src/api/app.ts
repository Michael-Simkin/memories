import { existsSync } from 'node:fs';
import path from 'node:path';

import express, { type Request, type Response } from 'express';
import { z } from 'zod';

import { EmbeddingClient } from '../retrieval/embeddings.js';
import { RetrievalService } from '../retrieval/hybrid-retrieval.js';
import {
  DEFAULT_BACKGROUND_HOOK_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_BACKGROUND_HOOK_MAX_RUNTIME_MS,
  DEFAULT_BACKGROUND_HOOK_SWEEP_INTERVAL_MS,
  DEFAULT_ENGINE_DRAIN_GRACE_MS,
  OLLAMA_PROFILE_CONFIG,
  resolveOllamaProfile,
} from '../shared/constants.js';
import { isPidAlive } from '../shared/fs-utils.js';
import { updateConnectedSessions } from '../shared/lockfile.js';
import { logError, logWarn } from '../shared/logger.js';
import { appendEventLog, readEventLogs } from '../shared/logs.js';
import {
  addMemoryInputSchema,
  type BackgroundHookRecord,
  memoryEventLogSchema,
  searchRequestSchema,
  updateMemoryInputSchema,
} from '../shared/types.js';
import { MemoryStore } from '../storage/database.js';
import { sendError } from './errors.js';

export interface EngineAppOptions {
  pluginRoot: string;
  projectRoot: string;
  lockPath: string;
  eventLogPath: string;
  port: number;
  sqliteVecExtensionPath: string | null;
  onSessionDrain: () => Promise<void>;
  drainGraceMs?: number;
  backgroundHookPolicy?: Partial<{
    heartbeatTimeoutMs: number;
    maxRuntimeMs: number;
    sweepIntervalMs: number;
  }>;
}

export interface EngineAppRuntime {
  app: express.Express;
  close: () => void;
  getSessionCount: () => number;
}

const sessionsPayloadSchema = z.object({
  session_id: z.string().trim().min(1),
});

const listMemoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const memoryIdParamSchema = z.object({
  id: z.string().trim().min(1),
});

const backgroundHookStartSchema = z.object({
  id: z.string().trim().min(1),
  hook_name: z.string().trim().min(1),
  session_id: z.string().trim().min(1).optional(),
  detail: z.string().trim().min(1).optional(),
  pid: z.number().int().positive().optional(),
});

const backgroundHookHeartbeatSchema = z.object({
  detail: z.string().trim().min(1).optional(),
  pid: z.number().int().positive().optional(),
});

const backgroundHookFinishSchema = z.object({
  status: z.enum(['ok', 'error', 'skipped']),
  detail: z.string().trim().min(1).optional(),
  pid: z.number().int().positive().optional(),
});

interface ActiveBackgroundHook {
  id: string;
  hook_name: string;
  session_id?: string;
  detail?: string;
  pid?: number;
  startedAtMs: number;
  lastHeartbeatAtMs: number;
  staleAtMs: number;
  hardTimeoutAtMs: number;
}

function toEventLog(input: z.infer<typeof memoryEventLogSchema>): z.infer<typeof memoryEventLogSchema> {
  return memoryEventLogSchema.parse(input);
}

export function createEngineApp(options: EngineAppOptions): EngineAppRuntime {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const startedAtMs = Date.now();
  const backgroundHookPolicy = {
    heartbeatTimeoutMs:
      options.backgroundHookPolicy?.heartbeatTimeoutMs ?? DEFAULT_BACKGROUND_HOOK_HEARTBEAT_TIMEOUT_MS,
    maxRuntimeMs: options.backgroundHookPolicy?.maxRuntimeMs ?? DEFAULT_BACKGROUND_HOOK_MAX_RUNTIME_MS,
    sweepIntervalMs:
      options.backgroundHookPolicy?.sweepIntervalMs ?? DEFAULT_BACKGROUND_HOOK_SWEEP_INTERVAL_MS,
  };
  const drainGraceMs = options.drainGraceMs ?? DEFAULT_ENGINE_DRAIN_GRACE_MS;
  const profile = resolveOllamaProfile(process.env.MEMORIES_OLLAMA_PROFILE);
  const store = new MemoryStore({
    dbPath: path.join(options.projectRoot, '.memories', 'ai_memory.db'),
    pluginRoot: options.pluginRoot,
    sqliteVecExtensionPath: options.sqliteVecExtensionPath,
    embeddingDimensions: OLLAMA_PROFILE_CONFIG[profile].dimensions,
  });
  const embeddingClient = new EmbeddingClient();
  const retrieval = new RetrievalService(store, embeddingClient);
  const activeSessions = new Set<string>();
  const activeBackgroundHooks = new Map<string, ActiveBackgroundHook>();
  let drainTriggered = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  function clearDrainTimer(): void {
    if (!drainTimer) {
      return;
    }
    clearTimeout(drainTimer);
    drainTimer = null;
  }

  function cancelDrain(): void {
    clearDrainTimer();
    drainTriggered = false;
  }

  function serializeBackgroundHook(hook: ActiveBackgroundHook): BackgroundHookRecord {
    return {
      id: hook.id,
      hook_name: hook.hook_name,
      state: 'running',
      started_at: new Date(hook.startedAtMs).toISOString(),
      last_heartbeat_at: new Date(hook.lastHeartbeatAtMs).toISOString(),
      stale_at: new Date(hook.staleAtMs).toISOString(),
      hard_timeout_at: new Date(hook.hardTimeoutAtMs).toISOString(),
      ...(hook.session_id ? { session_id: hook.session_id } : {}),
      ...(hook.detail ? { detail: hook.detail } : {}),
      ...(typeof hook.pid === 'number' ? { pid: hook.pid } : {}),
    };
  }

  async function maybeTriggerDrain(): Promise<void> {
    if (
      drainTriggered ||
      drainTimer ||
      activeSessions.size > 0 ||
      activeBackgroundHooks.size > 0
    ) {
      return;
    }

    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (drainTriggered || activeSessions.size > 0 || activeBackgroundHooks.size > 0) {
        return;
      }
      drainTriggered = true;
      void options.onSessionDrain().catch((error) => {
        logError('Session drain callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, drainGraceMs);
    drainTimer.unref?.();
  }

  async function appendBackgroundHookLifecycleEvent(
    event: 'background-hook/start' | 'background-hook/finish' | 'background-hook/expire',
    hook: ActiveBackgroundHook,
    status: 'ok' | 'error' | 'skipped',
    detail?: string,
  ): Promise<void> {
    const runtimeMs = Math.max(0, Date.now() - hook.startedAtMs);
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event,
        kind: 'hook',
        status,
        ...(hook.session_id ? { session_id: hook.session_id } : {}),
        detail: detail ?? hook.hook_name,
        data: {
          hook_id: hook.id,
          hook_name: hook.hook_name,
          runtime_ms: runtimeMs,
          ...(typeof hook.pid === 'number' ? { pid: hook.pid } : {}),
        },
      }),
    );
  }

  async function sweepExpiredBackgroundHooks(): Promise<void> {
    const now = Date.now();
    const expired: Array<{ detail: string; hook: ActiveBackgroundHook }> = [];

    for (const hook of activeBackgroundHooks.values()) {
      if (now >= hook.hardTimeoutAtMs) {
        expired.push({
          hook,
          detail: `${hook.hook_name} exceeded max runtime of ${backgroundHookPolicy.maxRuntimeMs}ms`,
        });
        continue;
      }
      if (now >= hook.staleAtMs) {
        expired.push({
          hook,
          detail: `${hook.hook_name} heartbeat timed out after ${backgroundHookPolicy.heartbeatTimeoutMs}ms`,
        });
        continue;
      }
      if (typeof hook.pid === 'number' && !isPidAlive(hook.pid)) {
        expired.push({
          hook,
          detail: `${hook.hook_name} process ${hook.pid} is no longer alive`,
        });
      }
    }

    if (expired.length === 0) {
      return;
    }

    for (const entry of expired) {
      activeBackgroundHooks.delete(entry.hook.id);
      await appendBackgroundHookLifecycleEvent(
        'background-hook/expire',
        entry.hook,
        'error',
        entry.detail,
      );
    }

    await maybeTriggerDrain();
  }

  const backgroundHookSweepTimer = setInterval(() => {
    void sweepExpiredBackgroundHooks().catch((error) => {
      logError('Background hook sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, backgroundHookPolicy.sweepIntervalMs);
  backgroundHookSweepTimer.unref?.();

  const staticUiDir = path.join(options.pluginRoot, 'web', 'dist');
  if (existsSync(staticUiDir)) {
    app.use('/ui', express.static(staticUiDir));
    app.get('/ui{*path}', (request, response, next) => {
      if (request.path.startsWith('/ui/assets/')) {
        next();
        return;
      }
      response.sendFile(path.join(staticUiDir, 'index.html'));
    });
  }

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      ok: true,
      port: options.port,
    });
  });

  app.get('/stats', async (_request: Request, response: Response) => {
    await sweepExpiredBackgroundHooks();
    response.json({
      active_sessions: activeSessions.size,
      active_background_hooks: activeBackgroundHooks.size,
      memory_count: store.memoryCount(),
      online: true,
      shutdown_blocked: activeSessions.size === 0 && activeBackgroundHooks.size > 0,
      uptime_ms: Date.now() - startedAtMs,
    });
  });

  app.post('/sessions/connect', async (request: Request, response: Response) => {
    const parsed = sessionsPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_SESSION_ID', parsed.error.message);
    }

    const sessionId = parsed.data.session_id;
    activeSessions.add(sessionId);
    cancelDrain();
    await updateConnectedSessions(options.lockPath, (currentSessions) => [...currentSessions, sessionId]);

    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event: 'sessions/connect',
        kind: 'hook',
        status: 'ok',
        session_id: sessionId,
      }),
    );

    return response.json({ active_sessions: activeSessions.size, ok: true });
  });

  app.post('/sessions/disconnect', async (request: Request, response: Response) => {
    const parsed = sessionsPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_SESSION_ID', parsed.error.message);
    }

    const sessionId = parsed.data.session_id;
    activeSessions.delete(sessionId);
    await updateConnectedSessions(options.lockPath, (currentSessions) =>
      currentSessions.filter((value) => value !== sessionId),
    );

    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event: 'sessions/disconnect',
        kind: 'hook',
        status: 'ok',
        session_id: sessionId,
      }),
    );

    await maybeTriggerDrain();

    return response.json({ active_sessions: activeSessions.size, ok: true });
  });

  app.get('/background-hooks', async (_request: Request, response: Response) => {
    await sweepExpiredBackgroundHooks();
    const items = [...activeBackgroundHooks.values()]
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((hook) => serializeBackgroundHook(hook));
    return response.json({
      items,
      meta: {
        active: items.length,
        now: new Date().toISOString(),
      },
    });
  });

  app.post('/background-hooks/start', async (request: Request, response: Response) => {
    const parsed = backgroundHookStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_BACKGROUND_HOOK', parsed.error.message);
    }

    await sweepExpiredBackgroundHooks();
    cancelDrain();

    const now = Date.now();
    const nextHook: ActiveBackgroundHook = {
      id: parsed.data.id,
      hook_name: parsed.data.hook_name,
      startedAtMs: now,
      lastHeartbeatAtMs: now,
      staleAtMs: now + backgroundHookPolicy.heartbeatTimeoutMs,
      hardTimeoutAtMs: now + backgroundHookPolicy.maxRuntimeMs,
      ...(parsed.data.session_id ? { session_id: parsed.data.session_id } : {}),
      ...(parsed.data.detail ? { detail: parsed.data.detail } : {}),
      ...(typeof parsed.data.pid === 'number' ? { pid: parsed.data.pid } : {}),
    };
    activeBackgroundHooks.set(nextHook.id, nextHook);

    await appendBackgroundHookLifecycleEvent('background-hook/start', nextHook, 'ok');
    return response.status(201).json({ active: true, ok: true });
  });

  app.post('/background-hooks/:id/heartbeat', async (request: Request, response: Response) => {
    const parsedId = memoryIdParamSchema.safeParse(request.params);
    if (!parsedId.success) {
      return sendError(response, 400, 'INVALID_BACKGROUND_HOOK_ID', parsedId.error.message);
    }
    const parsedBody = backgroundHookHeartbeatSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return sendError(response, 400, 'INVALID_BACKGROUND_HOOK', parsedBody.error.message);
    }

    await sweepExpiredBackgroundHooks();

    const current = activeBackgroundHooks.get(parsedId.data.id);
    if (!current) {
      return response.json({ active: false, ok: true });
    }

    const now = Date.now();
    activeBackgroundHooks.set(parsedId.data.id, {
      ...current,
      lastHeartbeatAtMs: now,
      staleAtMs: now + backgroundHookPolicy.heartbeatTimeoutMs,
      ...(parsedBody.data.detail ? { detail: parsedBody.data.detail } : {}),
      ...(typeof parsedBody.data.pid === 'number' ? { pid: parsedBody.data.pid } : {}),
    });
    return response.json({ active: true, ok: true });
  });

  app.post('/background-hooks/:id/finish', async (request: Request, response: Response) => {
    const parsedId = memoryIdParamSchema.safeParse(request.params);
    if (!parsedId.success) {
      return sendError(response, 400, 'INVALID_BACKGROUND_HOOK_ID', parsedId.error.message);
    }
    const parsedBody = backgroundHookFinishSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return sendError(response, 400, 'INVALID_BACKGROUND_HOOK', parsedBody.error.message);
    }

    await sweepExpiredBackgroundHooks();

    const current = activeBackgroundHooks.get(parsedId.data.id);
    if (!current) {
      return response.json({ active: false, ok: true });
    }

    const finalHook: ActiveBackgroundHook = {
      ...current,
      ...(parsedBody.data.detail ? { detail: parsedBody.data.detail } : {}),
      ...(typeof parsedBody.data.pid === 'number' ? { pid: parsedBody.data.pid } : {}),
    };
    activeBackgroundHooks.delete(parsedId.data.id);
    await appendBackgroundHookLifecycleEvent(
      'background-hook/finish',
      finalHook,
      parsedBody.data.status,
      parsedBody.data.detail,
    );
    await maybeTriggerDrain();
    return response.json({ active: false, ok: true });
  });

  app.get('/memories/pinned', (_request: Request, response: Response) => {
    const startedAt = Date.now();
    const results = store.getPinnedMemories();
    return response.json({
      meta: {
        duration_ms: Date.now() - startedAt,
        query: 'pinned',
        returned: results.length,
        source: 'hybrid',
      },
      results,
    });
  });

  app.post('/memories/search', async (request: Request, response: Response) => {
    const parsed = searchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    const startedAt = Date.now();
    const results = await retrieval.search({
      query: parsed.data.query,
      limit: parsed.data.limit,
      includePinned: parsed.data.include_pinned,
      targetPaths: parsed.data.target_paths,
      memoryTypes: parsed.data.memory_types,
      lexicalK: parsed.data.lexical_k,
      semanticK: parsed.data.semantic_k,
      responseTokenBudget: parsed.data.response_token_budget,
    });

    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event: 'memory/search',
        kind: 'operation',
        status: 'ok',
        detail: `returned=${results.length}`,
      }),
    );

    return response.json({
      meta: {
        duration_ms: Date.now() - startedAt,
        query: parsed.data.query,
        returned: results.length,
        source: 'hybrid',
      },
      results,
    });
  });

  app.post('/memories/add', async (request: Request, response: Response) => {
    const parsed = addMemoryInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    let vector: number[] | null = null;
    if (embeddingClient.isConfigured()) {
      vector = await embeddingClient.embed(parsed.data.content);
    }

    const created = store.createMemory(parsed.data, vector);
    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event: 'memory/create',
        kind: 'operation',
        status: 'ok',
        memory_id: created.id,
      }),
    );

    return response.status(201).json({ memory: created });
  });

  app.get('/memories', (request: Request, response: Response) => {
    const parsed = listMemoriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_QUERY', parsed.error.message);
    }

    const items = store.listMemories(parsed.data.limit, parsed.data.offset);
    return response.json({
      items,
      total: store.memoryCount(),
    });
  });

  app.patch('/memories/:id', async (request: Request, response: Response) => {
    const parsedId = memoryIdParamSchema.safeParse(request.params);
    if (!parsedId.success) {
      return sendError(response, 400, 'INVALID_MEMORY_ID', parsedId.error.message);
    }
    const parsedBody = updateMemoryInputSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return sendError(response, 400, 'INVALID_PAYLOAD', parsedBody.error.message);
    }

    let vector: number[] | null | undefined = undefined;
    if (typeof parsedBody.data.content === 'string' && embeddingClient.isConfigured()) {
      vector = await embeddingClient.embed(parsedBody.data.content);
      if (!vector) {
        logWarn('Embedding update skipped due failed embedding request', {
          memoryId: parsedId.data.id,
        });
      }
    }

    const updated = store.updateMemory(parsedId.data.id, parsedBody.data, vector);
    if (!updated) {
      return sendError(response, 404, 'NOT_FOUND', `Memory ${parsedId.data.id} was not found`);
    }

    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event: 'memory/update',
        kind: 'operation',
        status: 'ok',
        memory_id: updated.id,
      }),
    );

    return response.json({ memory: updated });
  });

  app.delete('/memories/:id', async (request: Request, response: Response) => {
    const parsedId = memoryIdParamSchema.safeParse(request.params);
    if (!parsedId.success) {
      return sendError(response, 400, 'INVALID_MEMORY_ID', parsedId.error.message);
    }

    const deleted = store.deleteMemory(parsedId.data.id);
    if (!deleted) {
      return sendError(response, 404, 'NOT_FOUND', `Memory ${parsedId.data.id} was not found`);
    }

    await appendEventLog(
      options.eventLogPath,
      toEventLog({
        at: new Date().toISOString(),
        event: 'memory/delete',
        kind: 'operation',
        status: 'ok',
        memory_id: parsedId.data.id,
      }),
    );

    return response.json({ deleted: true, id: parsedId.data.id });
  });

  app.get('/logs', async (request: Request, response: Response) => {
    const parsed = logsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_QUERY', parsed.error.message);
    }

    const entries = await readEventLogs(options.eventLogPath, parsed.data.limit);
    const items = parsed.data.order === 'desc' ? [...entries].reverse() : entries;
    return response.json({ items });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return sendError(response, 500, 'INTERNAL_ERROR', message);
  });

  return {
    app,
    close: () => {
      clearDrainTimer();
      clearInterval(backgroundHookSweepTimer);
      store.close();
    },
    getSessionCount: () => activeSessions.size,
  };
}
