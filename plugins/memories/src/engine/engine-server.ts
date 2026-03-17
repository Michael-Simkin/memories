import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { ZodError } from "zod";

import {
  apiCreateMemoryRequestSchema,
  apiDeleteMemoryRequestSchema,
  apiPinnedMemoriesRequestSchema,
  apiSearchMemoriesRequestSchema,
  apiUpdateMemoryRequestSchema,
  enqueueLearningJobRequestSchema,
  spaceTouchRequestSchema,
} from "../api/schemas/index.js";
import { CLAUDE_MEMORY_VERSION } from "../shared/constants/version.js";
import {
  eventKindSchema,
  eventStatusSchema,
} from "../shared/schemas/events.js";
import { learningJobStateSchema } from "../shared/schemas/jobs.js";
import { ActiveMemorySpaceService } from "../shared/services/active-memory-space-service.js";
import { EngineHealthService } from "../shared/services/engine-health-service.js";
import { EngineLockService } from "../shared/services/engine-lock-service.js";
import { OllamaEmbeddingService } from "../shared/services/ollama-embedding-service.js";
import { RuntimeSupportService } from "../shared/services/runtime-support-service.js";
import type { WorkingPathSelectionInput } from "../shared/types/memory-space.js";
import type { PluginPathResolutionInput } from "../shared/types/plugin-paths.js";
import type { CurrentContext } from "../shared/types/space.js";
import type { ResolveStoragePathsOptions } from "../shared/types/storage.js";
import { ActiveSpaceLearningJobRepository } from "../storage/repositories/active-space-learning-job-repository.js";
import { ActiveSpaceMemoryRepository } from "../storage/repositories/active-space-memory-repository.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { EventRepository } from "../storage/repositories/event-repository.js";
import { LearningJobRepository } from "../storage/repositories/learning-job-repository.js";
import { MemoryRepository } from "../storage/repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../storage/repositories/space-registry-repository.js";
import { StorageStatsRepository } from "../storage/repositories/storage-stats-repository.js";
import type { UpdateActiveMemoryInput } from "../storage/types/memory.js";
import { resolveEngineIdleTimeoutMs } from "./config.js";

interface StartEngineServerOptions
  extends ResolveStoragePathsOptions,
    PluginPathResolutionInput {
  host?: string | undefined;
  idleTimeoutMs?: number | undefined;
  port?: number | undefined;
  registerSignalHandlers?: boolean | undefined;
}

export interface StartedEngineServer {
  close(): Promise<void>;
  closed: Promise<void>;
  host: string;
  idleTimeoutMs: number;
  port: number;
  startedAt: string;
}

const KNOWN_ROUTE_PATHS = new Set([
  "/health",
  "/learning-jobs",
  "/logs",
  "/memories",
  "/memories/add",
  "/memories/pinned",
  "/memories/search",
  "/spaces",
  "/spaces/touch",
  "/stats",
]);

function writeJsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function readRequestUrl(request: IncomingMessage): URL {
  const requestUrl = request.url ?? "/";

  return new URL(requestUrl, "http://127.0.0.1");
}

async function readJsonRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const bufferChunk = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), "utf8");

    chunks.push(bufferChunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function toWorkingPathSelectionInput(
  context: CurrentContext,
): WorkingPathSelectionInput {
  return {
    projectRoot: context.project_root,
    cwd: context.cwd,
  };
}

function readOptionalQueryText(requestUrl: URL, key: string): string | undefined {
  const rawValue = requestUrl.searchParams.get(key);

  if (rawValue === null) {
    return undefined;
  }

  const trimmedValue = rawValue.trim();

  if (trimmedValue.length === 0) {
    return undefined;
  }

  return trimmedValue;
}

function readOptionalPositiveIntegerQueryValue(
  requestUrl: URL,
  key: string,
  options: {
    max?: number;
  } = {},
): number | undefined {
  const rawValue = readOptionalQueryText(requestUrl, key);

  if (rawValue === undefined) {
    return undefined;
  }

  const numericValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  if (options.max !== undefined && numericValue > options.max) {
    throw new Error(`${key} must be no greater than ${String(options.max)}.`);
  }

  return numericValue;
}

function readMemoryRouteId(requestPath: string): string | null {
  if (!requestPath.startsWith("/memories/")) {
    return null;
  }

  const routeSuffix = requestPath.slice("/memories/".length);

  if (
    routeSuffix.length === 0 ||
    routeSuffix.includes("/") ||
    routeSuffix === "add" ||
    routeSuffix === "pinned" ||
    routeSuffix === "search"
  ) {
    return null;
  }

  return routeSuffix;
}

function resolveErrorStatusCode(error: unknown): number {
  if (error instanceof ZodError) {
    return 400;
  }

  if (!(error instanceof Error)) {
    return 500;
  }

  if (error.message === "Request body must be valid JSON.") {
    return 400;
  }

  if (
    error.message.startsWith("Unable to find memory space") ||
    error.message.startsWith("Unable to find memory ") ||
    error.message.startsWith("Unable to find learning job ")
  ) {
    return 404;
  }

  if (
    error.message.includes("must be a non-empty string") ||
    error.message.includes("must be a positive integer") ||
    error.message.includes("must be no greater than") ||
    error.message.includes("requires either") ||
    error.message.includes("requires at least one")
  ) {
    return 400;
  }

  return 500;
}

function writeErrorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof ZodError) {
    writeJsonResponse(response, 400, {
      error: "Invalid request.",
      issues: error.issues,
    });
    return;
  }

  writeJsonResponse(response, resolveErrorStatusCode(error), {
    error: error instanceof Error ? error.message : "Unknown engine error.",
  });
}

export async function startEngineServer(
  options: StartEngineServerOptions = {},
): Promise<StartedEngineServer> {
  RuntimeSupportService.assertSupportedRuntime();

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const idleTimeoutMs = resolveEngineIdleTimeoutMs(options.idleTimeoutMs);
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    claudeMemoryHome: options.claudeMemoryHome,
    currentWorkingDirectory: options.currentWorkingDirectory,
    pluginRoot: options.pluginRoot,
  });
  const startedAt = new Date().toISOString();
  let lastActivityAt = startedAt;
  let resolvedPort = 0;
  let isClosing = false;
  let semanticAvailable: boolean | null = null;
  let semanticDetail: string | null = null;
  let semanticLastCheckedAt: string | null = null;
  let closePromise: Promise<void> | null = null;
  let closedResolver: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    closedResolver = resolve;
  });
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  const refreshEngineLock = async (): Promise<void> => {
    if (resolvedPort === 0) {
      return;
    }

    await EngineLockService.writeEngineLock(
      {
        host,
        port: resolvedPort,
        pid: process.pid,
        started_at: startedAt,
        last_activity_at: lastActivityAt,
        version: CLAUDE_MEMORY_VERSION,
      },
      {
        claudeMemoryHome: options.claudeMemoryHome,
        currentWorkingDirectory: options.currentWorkingDirectory,
      },
    );
  };

  const touchActivity = async (): Promise<void> => {
    lastActivityAt = new Date().toISOString();
    await refreshEngineLock();
  };

  const updateSemanticStatus = (
    available: boolean,
    detail: string | null,
  ): void => {
    const nextCheckedAt = new Date().toISOString();
    const statusChanged =
      semanticAvailable !== available || semanticDetail !== detail;

    semanticAvailable = available;
    semanticDetail = detail;
    semanticLastCheckedAt = nextCheckedAt;

    if (!statusChanged) {
      return;
    }

    EventRepository.recordEvent(bootstrapResult.database, {
      at: nextCheckedAt,
      event: available ? "semantic-available" : "semantic-unavailable",
      kind: "engine",
      status: available ? "success" : "warning",
      detail,
      data: {
        available,
      },
    });
  };

  const tryEmbedText = async (text: string): Promise<number[] | undefined> => {
    try {
      const embedding = await OllamaEmbeddingService.embedText(text);

      updateSemanticStatus(true, null);
      return embedding;
    } catch (error) {
      updateSemanticStatus(
        false,
        error instanceof Error ? error.message : "Unknown Ollama error.",
      );
      return undefined;
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const requestMethod = request.method ?? "GET";
        const requestUrl = readRequestUrl(request);
        const requestPath = requestUrl.pathname;

        if (requestMethod === "GET" && requestPath === "/health") {
          writeJsonResponse(
            response,
            200,
            EngineHealthService.createExpectedHealth(
              DatabaseBootstrapRepository.getLatestSchemaVersion(),
            ),
          );
          return;
        }

        if (requestMethod === "GET" && requestPath === "/stats") {
          await touchActivity();

          writeJsonResponse(response, 200, {
            ...StorageStatsRepository.getStats(bootstrapResult.database),
            idle_timeout_ms: idleTimeoutMs,
            last_activity_at: lastActivityAt,
            online: true,
            semantic_available: semanticAvailable,
            semantic_detail: semanticDetail,
            semantic_last_checked_at: semanticLastCheckedAt,
            started_at: startedAt,
            uptime_ms: Date.now() - Date.parse(startedAt),
          });
          return;
        }

        if (requestMethod === "GET" && requestPath === "/spaces") {
          await touchActivity();

          writeJsonResponse(response, 200, {
            spaces: SpaceRegistryRepository.listSpaces(bootstrapResult.database),
          });
          return;
        }

        if (requestMethod === "POST" && requestPath === "/spaces/touch") {
          const parsedBody = spaceTouchRequestSchema.parse(
            await readJsonRequestBody(request),
          );
          const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace(
            toWorkingPathSelectionInput(parsedBody.context),
          );
          const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(
            bootstrapResult.database,
            {
              resolution,
            },
          );

          await touchActivity();
          writeJsonResponse(response, 200, touchResult);
          return;
        }

        if (requestMethod === "POST" && requestPath === "/memories/pinned") {
          const parsedBody = apiPinnedMemoriesRequestSchema.parse(
            await readJsonRequestBody(request),
          );
          const pinnedMemories = await ActiveSpaceMemoryRepository.listPinnedMemories(
            bootstrapResult.database,
            {
              spaceId: parsedBody.space_id,
              context: parsedBody.context,
            },
          );

          await touchActivity();
          writeJsonResponse(response, 200, pinnedMemories);
          return;
        }

        if (requestMethod === "POST" && requestPath === "/memories/search") {
          const parsedBody = apiSearchMemoriesRequestSchema.parse(
            await readJsonRequestBody(request),
          );
          const queryEmbedding = await tryEmbedText(parsedBody.query);
          const searchResponse = await ActiveSpaceMemoryRepository.searchMemories(
            bootstrapResult.database,
            {
              spaceId: parsedBody.space_id,
              context: parsedBody.context,
              query: parsedBody.query,
              queryEmbedding,
              relatedPaths: parsedBody.related_paths,
              limit: parsedBody.limit,
            },
          );

          await touchActivity();
          writeJsonResponse(response, 200, searchResponse);
          return;
        }

        if (requestMethod === "POST" && requestPath === "/learning-jobs") {
          const parsedBody = enqueueLearningJobRequestSchema.parse(
            await readJsonRequestBody(request),
          );
          const queuedJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
            bootstrapResult.database,
            {
              spaceId: parsedBody.space_id,
              context: parsedBody.context,
              transcriptPath: parsedBody.transcript_path,
              lastAssistantMessage: parsedBody.last_assistant_message,
              sessionId: parsedBody.session_id,
            },
          );

          await touchActivity();
          writeJsonResponse(response, 201, {
            job: queuedJob,
          });
          return;
        }

        if (requestMethod === "GET" && requestPath === "/memories") {
          const memories = MemoryRepository.listMemories(bootstrapResult.database, {
            spaceId: readOptionalQueryText(requestUrl, "space_id"),
            limit: readOptionalPositiveIntegerQueryValue(requestUrl, "limit", {
              max: 100,
            }),
          });

          await touchActivity();
          writeJsonResponse(response, 200, {
            memories,
          });
          return;
        }

        if (requestMethod === "POST" && requestPath === "/memories/add") {
          const parsedBody = apiCreateMemoryRequestSchema.parse(
            await readJsonRequestBody(request),
          );
          const semanticEmbedding = await tryEmbedText(parsedBody.content);
          const createdMemory = await ActiveSpaceMemoryRepository.createMemory(
            bootstrapResult.database,
            {
              spaceId: parsedBody.space_id,
              context: parsedBody.context,
              memoryType: parsedBody.memory_type,
              content: parsedBody.content,
              tags: parsedBody.tags,
              isPinned: parsedBody.is_pinned,
              pathMatchers: parsedBody.path_matchers,
              semanticEmbedding,
            },
          );

          await touchActivity();
          writeJsonResponse(response, 201, {
            memory: createdMemory,
          });
          return;
        }

        const memoryRouteId = readMemoryRouteId(requestPath);

        if (memoryRouteId !== null && requestMethod === "PATCH") {
          const parsedBody = apiUpdateMemoryRequestSchema.parse(
            await readJsonRequestBody(request),
          );
          const updateInput: UpdateActiveMemoryInput = {
            spaceId: parsedBody.space_id,
            context: parsedBody.context,
            memoryId: memoryRouteId,
            memoryType: parsedBody.memory_type,
            content: parsedBody.content,
            tags: parsedBody.tags,
            isPinned: parsedBody.is_pinned,
            pathMatchers: parsedBody.path_matchers,
          };

          if (parsedBody.content !== undefined) {
            const semanticEmbedding = await tryEmbedText(parsedBody.content);

            if (semanticEmbedding !== undefined) {
              updateInput.semanticEmbedding = semanticEmbedding;
            }
          }

          const updatedMemory = await ActiveSpaceMemoryRepository.updateMemory(
            bootstrapResult.database,
            updateInput,
          );

          await touchActivity();
          writeJsonResponse(response, 200, {
            memory: updatedMemory,
          });
          return;
        }

        if (memoryRouteId !== null && requestMethod === "DELETE") {
          const parsedBody = apiDeleteMemoryRequestSchema.parse(
            await readJsonRequestBody(request),
          );

          await ActiveSpaceMemoryRepository.deleteMemory(bootstrapResult.database, {
            spaceId: parsedBody.space_id,
            context: parsedBody.context,
            memoryId: memoryRouteId,
          });

          await touchActivity();
          writeJsonResponse(response, 200, {
            deleted: true,
            memory_id: memoryRouteId,
          });
          return;
        }

        if (requestMethod === "GET" && requestPath === "/learning-jobs") {
          const stateText = readOptionalQueryText(requestUrl, "state");
          const state =
            stateText === undefined ? undefined : learningJobStateSchema.parse(stateText);
          const jobs = LearningJobRepository.listLearningJobs(
            bootstrapResult.database,
            {
              spaceId: readOptionalQueryText(requestUrl, "space_id"),
              state,
              limit: readOptionalPositiveIntegerQueryValue(requestUrl, "limit"),
            },
          );

          await touchActivity();
          writeJsonResponse(response, 200, {
            jobs,
          });
          return;
        }

        if (requestMethod === "GET" && requestPath === "/logs") {
          const kindText = readOptionalQueryText(requestUrl, "kind");
          const statusText = readOptionalQueryText(requestUrl, "status");
          const events = EventRepository.listEvents(bootstrapResult.database, {
            spaceId: readOptionalQueryText(requestUrl, "space_id"),
            kind: kindText === undefined ? undefined : eventKindSchema.parse(kindText),
            status:
              statusText === undefined ? undefined : eventStatusSchema.parse(statusText),
            limit: readOptionalPositiveIntegerQueryValue(requestUrl, "limit"),
          });

          await touchActivity();
          writeJsonResponse(response, 200, {
            events,
          });
          return;
        }

        if (memoryRouteId !== null) {
          writeJsonResponse(response, 405, {
            error: "Method not allowed.",
          });
          return;
        }

        if (KNOWN_ROUTE_PATHS.has(requestPath)) {
          writeJsonResponse(response, 405, {
            error: "Method not allowed.",
          });
          return;
        }

        writeJsonResponse(response, 404, {
          error: `Unknown route "${requestPath}".`,
        });
      } catch (error) {
        writeErrorResponse(response, error);
      }
    })();
  });

  const close = async (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      if (isClosing) {
        return;
      }

      isClosing = true;
      clearInterval(idleInterval);

      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }

      if (server.listening) {
        server.close();
        await once(server, "close");
      }

      bootstrapResult.database.close();
      await EngineLockService.clearEngineLockIfOwned(process.pid, {
        claudeMemoryHome: options.claudeMemoryHome,
        currentWorkingDirectory: options.currentWorkingDirectory,
      });
      closedResolver?.();
    })();

    return closePromise;
  };

  const idleInterval = setInterval(() => {
    void (async () => {
      if (isClosing) {
        return;
      }

      const idleForMs = Date.now() - Date.parse(lastActivityAt);
      const hasRunningJob = StorageStatsRepository.getStats(
        bootstrapResult.database,
      ).runningJobs > 0;

      if (idleForMs < idleTimeoutMs || hasRunningJob) {
        return;
      }

      await close();
    })();
  }, Math.min(Math.max(250, Math.floor(idleTimeoutMs / 4)), 5_000));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await close();
    throw new Error("Claude Memory engine did not bind to a TCP port.");
  }

  resolvedPort = address.port;
  await refreshEngineLock();

  if (options.registerSignalHandlers === true) {
    const handleSignal = () => {
      void close();
    };

    signalHandlers.push(["SIGINT", handleSignal], ["SIGTERM", handleSignal]);

    for (const [signal, handler] of signalHandlers) {
      process.on(signal, handler);
    }
  }

  return {
    close,
    closed,
    host,
    idleTimeoutMs,
    port: resolvedPort,
    startedAt,
  };
}
