import { existsSync } from 'node:fs';
import path from 'node:path';

import express, { type Request, type Response } from 'express';

import { EmbeddingClient } from '../retrieval/embeddings.js';
import { RetrievalService } from '../retrieval/hybrid-retrieval.js';
import { DEFAULT_SEARCH_LIMIT, ENGINE_HOST } from '../shared/constants.js';
import { updateConnectedSessions } from '../shared/lockfile.js';
import { error, warn } from '../shared/logger.js';
import { appendOperationLog, hookLog, readJsonLogs } from '../shared/logs.js';
import { formatMemoryRecallMarkdown } from '../shared/markdown.js';
import { applyTokenBudget } from '../shared/token-budget.js';
import {
  addMemorySchema,
  retrievalPretoolSchema,
  searchRequestSchema,
  updateMemorySchema,
} from '../shared/types.js';
import { MemoryStore } from '../storage/database.js';
import { sendError } from './errors.js';

export interface EngineAppOptions {
  pluginRoot: string;
  projectRoot: string;
  lockPath: string;
  operationLogPath: string;
  hookLogPath: string;
  port: number;
  onSessionDrain: () => Promise<void>;
}

export interface EngineAppRuntime {
  app: express.Express;
  getSessionCount: () => number;
}

function parseIntQuery(value: unknown, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePathParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
    return value[0];
  }
  return null;
}

export function createEngineApp(options: EngineAppOptions): EngineAppRuntime {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const startedAtMs = Date.now();
  const store = new MemoryStore(path.join(options.projectRoot, '.memories', 'ai_memory.db'));
  const embeddings = new EmbeddingClient();
  const retrieval = new RetrievalService(store, embeddings);
  const activeSessions = new Set<string>();

  const staticUiDir = path.join(options.pluginRoot, 'web', 'dist');
  if (existsSync(staticUiDir)) {
    app.use('/ui', express.static(staticUiDir));
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ host: ENGINE_HOST, ok: true, port: options.port });
  });

  app.get('/stats', async (_req: Request, res: Response) => {
    return res.json({
      active_sessions: activeSessions.size,
      memory_count: store.memoryCount(),
      online: true,
      uptime_ms: Date.now() - startedAtMs,
    });
  });

  app.post('/sessions/connect', async (req: Request, res: Response) => {
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.trim() : '';
    if (!sessionId) {
      return sendError(res, 400, 'INVALID_SESSION_ID', 'session_id is required');
    }

    activeSessions.add(sessionId);
    await updateConnectedSessions(options.lockPath, (current) => [...current, sessionId]);
    await hookLog(options.hookLogPath, {
      at: new Date().toISOString(),
      event: 'sessions/connect',
      status: 'ok',
      session_id: sessionId,
    });
    return res.json({ connected_session_ids: [...activeSessions] });
  });

  app.post('/sessions/disconnect', async (req: Request, res: Response) => {
    const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id.trim() : '';
    if (!sessionId) {
      return sendError(res, 400, 'INVALID_SESSION_ID', 'session_id is required');
    }

    activeSessions.delete(sessionId);
    await updateConnectedSessions(options.lockPath, (current) =>
      current.filter((value) => value !== sessionId),
    );
    await hookLog(options.hookLogPath, {
      at: new Date().toISOString(),
      event: 'sessions/disconnect',
      status: 'ok',
      session_id: sessionId,
    });

    if (activeSessions.size === 0) {
      void options.onSessionDrain().catch((drainError: unknown) => {
        error('onSessionDrain failed', {
          error: drainError instanceof Error ? drainError.message : String(drainError),
        });
      });
    }

    return res.json({ connected_session_ids: [...activeSessions] });
  });

  app.get('/memories/pinned', (_req: Request, res: Response) => {
    const started = Date.now();
    const results = store.getPinnedMemories();
    return res.json({
      meta: {
        duration_ms: Date.now() - started,
        query: 'session-start:pinned',
        returned: results.length,
        source: 'engine:/memories/pinned',
      },
      results,
    });
  });

  app.post('/retrieval/pretool', async (req: Request, res: Response) => {
    const parsed = retrievalPretoolSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    const started = Date.now();
    const results = await retrieval.searchForPretool({
      query: parsed.data.query,
      targetPaths: parsed.data.target_paths,
      limit: DEFAULT_SEARCH_LIMIT,
      includePinned: true,
      lexicalK: 30,
      semanticK: 30,
    });
    const bounded = applyTokenBudget(results, parsed.data.max_tokens);
    const durationMs = Date.now() - started;
    const markdown = formatMemoryRecallMarkdown({
      query: parsed.data.query || `paths:${parsed.data.target_paths.join(',') || 'none'}`,
      results: bounded,
      durationMs,
      source: 'engine:/retrieval/pretool',
    });
    return res.json({
      markdown,
      meta: {
        duration_ms: durationMs,
        query: parsed.data.query,
        returned: bounded.length,
        source: 'engine:/retrieval/pretool',
      },
      results: bounded,
    });
  });

  app.post('/memories/search', async (req: Request, res: Response) => {
    const parsed = searchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    const started = Date.now();
    const results = await retrieval.search({
      query: parsed.data.query,
      limit: parsed.data.limit,
      includePinned: parsed.data.include_pinned,
      lexicalK: 30,
      semanticK: 30,
      ...(parsed.data.memory_types ? { memoryTypes: parsed.data.memory_types } : {}),
    });

    return res.json({
      meta: {
        duration_ms: Date.now() - started,
        query: parsed.data.query,
        returned: results.length,
        source: 'engine:/memories/search',
      },
      results,
    });
  });

  app.post('/memories/add', async (req: Request, res: Response) => {
    const parsed = addMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    const memory = store.createMemory(parsed.data);
    if (embeddings.isConfigured()) {
      const vector = await embeddings.embed(memory.content);
      if (vector) {
        store.upsertEmbedding(memory.id, vector);
      } else {
        warn('Semantic embedding skipped for memory', { memoryId: memory.id });
      }
    }
    await appendOperationLog(options.operationLogPath, {
      at: new Date().toISOString(),
      op: 'memory/create',
      status: 'ok',
      memory_id: memory.id,
      data: { memory_type: memory.memory_type, is_pinned: memory.is_pinned },
    });
    return res.status(201).json({ memory });
  });

  app.get('/memories', (req: Request, res: Response) => {
    const limit = parseIntQuery(req.query.limit, 50);
    const offset = parseIntQuery(req.query.offset, 0);
    const records = store.listMemories(limit, offset);
    return res.json({
      items: records,
      total: store.memoryCount(),
    });
  });

  app.patch('/memories/:id', async (req: Request, res: Response) => {
    const id = parsePathParam(req.params.id);
    if (!id) {
      return sendError(res, 400, 'INVALID_MEMORY_ID', 'Memory id path param is required');
    }
    const parsed = updateMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'INVALID_PAYLOAD', parsed.error.message);
    }

    const updated = store.updateMemory(id, parsed.data);
    if (!updated) {
      return sendError(res, 404, 'NOT_FOUND', `Memory ${id} was not found`);
    }

    if (parsed.data.content && embeddings.isConfigured()) {
      const vector = await embeddings.embed(parsed.data.content);
      if (vector) {
        store.upsertEmbedding(updated.id, vector);
      }
    }
    await appendOperationLog(options.operationLogPath, {
      at: new Date().toISOString(),
      op: 'memory/update',
      status: 'ok',
      memory_id: updated.id,
    });
    return res.json({ memory: updated });
  });

  app.delete('/memories/:id', async (req: Request, res: Response) => {
    const id = parsePathParam(req.params.id);
    if (!id) {
      return sendError(res, 400, 'INVALID_MEMORY_ID', 'Memory id path param is required');
    }
    const deleted = store.deleteMemory(id);
    if (!deleted) {
      return sendError(res, 404, 'NOT_FOUND', `Memory ${id} was not found`);
    }
    await appendOperationLog(options.operationLogPath, {
      at: new Date().toISOString(),
      op: 'memory/delete',
      status: 'ok',
      memory_id: id,
    });
    return res.json({ deleted: true, id });
  });

  app.get('/logs/operations', async (req: Request, res: Response) => {
    const limit = parseIntQuery(req.query.limit, 200);
    const logs = await readJsonLogs(options.operationLogPath, limit);
    return res.json({ items: logs });
  });

  app.get('/logs/hooks', async (req: Request, res: Response) => {
    const limit = parseIntQuery(req.query.limit, 200);
    const logs = await readJsonLogs(options.hookLogPath, limit);
    return res.json({ items: logs });
  });

  if (existsSync(staticUiDir)) {
    app.get('{*path}', (req: Request, res: Response, next) => {
      if (
        req.path.startsWith('/api/') ||
        req.path.startsWith('/memories') ||
        req.path.startsWith('/logs')
      ) {
        return next();
      }
      const indexPath = path.join(staticUiDir, 'index.html');
      return res.sendFile(indexPath);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return sendError(res, 500, 'INTERNAL_ERROR', message);
  });

  return {
    app,
    getSessionCount: () => activeSessions.size,
  };
}
