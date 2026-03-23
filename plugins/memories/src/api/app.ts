import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  DEFAULT_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  LOOPBACK_HOST,
  OLLAMA_PROFILE_CONFIG,
  resolveOllamaProfile,
} from '../shared/constants.js';
import { isPidAlive } from '../shared/fs-utils.js';
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
import { BackfillOrchestrator } from '../backfill/orchestrator.js';
import { sendError } from './errors.js';

export interface EngineAppOptions {
  pluginRoot: string;
  dbPath: string;
  lockPath: string;
  eventLogPath: string;
  port: number;
  sqliteVecExtensionPath: string | null;
  onIdleTimeout: () => Promise<void>;
  onShutdownRequest?: () => Promise<void>;
  idleTimeoutMs?: number;
  idleCheckIntervalMs?: number;
  backgroundHookPolicy?: Partial<{
    heartbeatTimeoutMs: number;
    maxRuntimeMs: number;
    sweepIntervalMs: number;
  }>;
}

export interface EngineAppRuntime {
  app: express.Express;
  close: () => void;
}

const repoIdSchema = z.string().trim().min(1);

const repoIdQuerySchema = z.object({
  repo_id: repoIdSchema,
});

const listMemoriesQuerySchema = z.object({
  repo_id: repoIdSchema,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const pinnedQuerySchema = z.object({
  repo_id: repoIdSchema,
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

const extractionEnqueueSchema = z.object({
  transcript_path: z.string().trim().min(1),
  project_root: z.string().trim().min(1),
  repo_id: z.string().trim().min(1),
  session_id: z.string().trim().min(1).optional(),
  last_assistant_message: z.string().optional(),
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleCheckIntervalMs = options.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS;
  const profile = resolveOllamaProfile(process.env.MEMORIES_OLLAMA_PROFILE);
  const store = new MemoryStore({
    dbPath: options.dbPath,
    sqliteVecExtensionPath: options.sqliteVecExtensionPath,
    embeddingDimensions: OLLAMA_PROFILE_CONFIG[profile].dimensions,
  });
  const embeddingClient = new EmbeddingClient();
  const retrieval = new RetrievalService(store, embeddingClient);
  const activeBackgroundHooks = new Map<string, ActiveBackgroundHook>();
  let lastInteractionAtMs = Date.now();
  let idleShutdownTriggered = false;
  const extractionQueue: z.infer<typeof extractionEnqueueSchema>[] = [];
  let activeExtractionChild: ReturnType<typeof spawn> | null = null;
  let activeExtractionJob: z.infer<typeof extractionEnqueueSchema> | null = null;

  function resetIdleTimer(): void {
    lastInteractionAtMs = Date.now();
  }

  app.use((request: Request, _response: Response, next: express.NextFunction) => {
    if (request.path !== '/health') {
      resetIdleTimer();
    }
    next();
  });

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

  function checkIdleTimeout(): void {
    if (idleShutdownTriggered) {
      return;
    }
    if (activeBackgroundHooks.size > 0) {
      return;
    }
    if (Date.now() - lastInteractionAtMs < idleTimeoutMs) {
      return;
    }
    idleShutdownTriggered = true;
    void options.onIdleTimeout().catch((error) => {
      logError('Idle timeout callback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
  }

  function processNextExtraction(): void {
    if (activeExtractionChild || extractionQueue.length === 0) {
      return;
    }

    const job = extractionQueue.shift()!;
    activeExtractionJob = job;
    const backgroundHookId = randomUUID();
    const now = Date.now();

    const hook: ActiveBackgroundHook = {
      id: backgroundHookId,
      hook_name: 'extraction',
      startedAtMs: now,
      lastHeartbeatAtMs: now,
      staleAtMs: now + backgroundHookPolicy.heartbeatTimeoutMs,
      hardTimeoutAtMs: now + backgroundHookPolicy.maxRuntimeMs,
      ...(job.session_id ? { session_id: job.session_id } : {}),
    };
    activeBackgroundHooks.set(backgroundHookId, hook);
    void appendBackgroundHookLifecycleEvent('background-hook/start', hook, 'ok');

    const handoff = {
      background_hook_id: backgroundHookId,
      endpoint: { host: LOOPBACK_HOST, port: options.port },
      ...job,
    };
    const encoded = Buffer.from(JSON.stringify(handoff), 'utf8').toString('base64');
    const workerPath = path.join(options.pluginRoot, 'dist', 'extraction', 'run.js');

    const child = spawn(process.execPath, [workerPath, '--handoff', encoded], {
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: options.pluginRoot },
    });

    if (typeof child.pid === 'number') {
      hook.pid = child.pid;
    }

    activeExtractionChild = child;
    let exited = false;

    const onChildExit = () => {
      if (exited) {
        return;
      }
      exited = true;
      const finished = activeBackgroundHooks.get(backgroundHookId);
      if (finished) {
        activeBackgroundHooks.delete(backgroundHookId);
        void appendBackgroundHookLifecycleEvent(
          'background-hook/finish',
          finished,
          'ok',
          'extraction worker exited',
        );
      }
      activeExtractionChild = null;
      activeExtractionJob = null;
      processNextExtraction();
    };

    child.on('close', onChildExit);
    child.on('error', (error) => {
      logError('Extraction worker spawn error', {
        error: error instanceof Error ? error.message : String(error),
      });
      onChildExit();
    });
  }

  const backgroundHookSweepTimer = setInterval(() => {
    void sweepExpiredBackgroundHooks().catch((error) => {
      logError('Background hook sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, backgroundHookPolicy.sweepIntervalMs);
  backgroundHookSweepTimer.unref?.();

  const idleCheckTimer = setInterval(() => {
    checkIdleTimeout();
  }, idleCheckIntervalMs);
  idleCheckTimer.unref?.();

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

  app.post('/shutdown', async (_request: Request, response: Response) => {
    if (!options.onShutdownRequest) {
      return sendError(response, 501, 'NOT_CONFIGURED', 'Shutdown callback not configured');
    }
    response.json({ status: 'shutting_down' });
    response.once('finish', () => {
      void options.onShutdownRequest!().catch((error) => {
        logError('Shutdown request callback failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  });

  const backfillOrchestrator = new BackfillOrchestrator(
    { host: LOOPBACK_HOST, port: options.port },
    options.pluginRoot,
  );

  app.post('/backfill/start', (request: Request, response: Response) => {
    const repoId = (request.body as Record<string, unknown>)?.repo_id;
    if (typeof repoId !== 'string' || !repoId.trim()) {
      return sendError(response, 400, 'MISSING_REPO_ID', 'repo_id is required');
    }
    if (backfillOrchestrator.isRunning()) {
      return sendError(response, 409, 'ALREADY_RUNNING', 'Backfill is already in progress');
    }
    void backfillOrchestrator.run(repoId);
    response.json({ status: 'started' });
  });

  app.get('/backfill/status', (_request: Request, response: Response) => {
    response.json(backfillOrchestrator.getState());
  });

  app.post('/backfill/cancel', (_request: Request, response: Response) => {
    if (!backfillOrchestrator.isRunning()) {
      return sendError(response, 400, 'NOT_RUNNING', 'No backfill in progress');
    }
    backfillOrchestrator.cancel();
    response.json({ status: 'cancelled' });
  });

  app.get('/stats', async (_request: Request, response: Response) => {
    await sweepExpiredBackgroundHooks();
    const now = Date.now();
    response.json({
      active_background_hooks: activeBackgroundHooks.size,
      online: true,
      uptime_ms: now - startedAtMs,
      last_interaction_at: new Date(lastInteractionAtMs).toISOString(),
      idle_timeout_ms: idleTimeoutMs,
      idle_remaining_ms: Math.max(0, idleTimeoutMs - (now - lastInteractionAtMs)),
    });
  });

  app.get('/repos', (_request: Request, response: Response) => {
    const repos = store.listRepos();
    return response.json({ repos });
  });

  app.post('/repos/label', (request: Request, response: Response) => {
    const parsed = z.object({
      repo_id: z.string().trim().min(1),
      label: z.string().trim().min(1),
    }).safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }
    store.upsertRepoLabel(parsed.data.repo_id, parsed.data.label);
    return response.json({ ok: true });
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
    return response.json({ active: false, ok: true });
  });

  app.get('/extraction/status', (_request: Request, response: Response) => {
    const summary = (job: z.infer<typeof extractionEnqueueSchema>) => ({
      repo_id: job.repo_id,
      transcript_path: job.transcript_path,
      ...(job.session_id ? { session_id: job.session_id } : {}),
    });
    return response.json({
      active: activeExtractionJob ? summary(activeExtractionJob) : null,
      queue: extractionQueue.map(summary),
    });
  });

  app.post('/extraction/enqueue', (request: Request, response: Response) => {
    const parsed = extractionEnqueueSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    const existingIndex = extractionQueue.findIndex((job) => job.repo_id === parsed.data.repo_id);
    if (existingIndex !== -1) {
      extractionQueue[existingIndex] = parsed.data;
    } else {
      extractionQueue.push(parsed.data);
    }
    processNextExtraction();
    return response.status(202).json({ ok: true });
  });

  app.get('/memories/pinned', (request: Request, response: Response) => {
    const parsed = pinnedQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(response, 400, 'INVALID_QUERY', parsed.error.message);
    }

    const startedAt = Date.now();
    const results = store.getPinnedMemories(parsed.data.repo_id);
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
    const results = await retrieval.search(parsed.data.repo_id, {
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

    const created = store.createMemory(parsed.data.repo_id, parsed.data, vector);
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

    const items = store.listMemories(parsed.data.repo_id, parsed.data.limit, parsed.data.offset);
    return response.json({
      items,
      total: store.memoryCount(parsed.data.repo_id),
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

    const updated = store.updateMemory(parsedBody.data.repo_id, parsedId.data.id, parsedBody.data, vector);
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

    const parsedQuery = repoIdQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return sendError(response, 400, 'INVALID_QUERY', parsedQuery.error.message);
    }

    const deleted = store.deleteMemory(parsedQuery.data.repo_id, parsedId.data.id);
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
      clearInterval(backgroundHookSweepTimer);
      clearInterval(idleCheckTimer);
      extractionQueue.length = 0;
      activeExtractionJob = null;
      if (activeExtractionChild) {
        activeExtractionChild.kill();
        activeExtractionChild = null;
      }
      store.close();
    },
  };
}
