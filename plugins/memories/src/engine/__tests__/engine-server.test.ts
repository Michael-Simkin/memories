import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { EngineLockService } from "../../shared/services/engine-lock-service.js";
import { startEngineServer } from "../engine-server.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";
import { EventRepository } from "../../storage/repositories/event-repository.js";
import { LearningJobRepository } from "../../storage/repositories/learning-job-repository.js";
import { MemoryRepository } from "../../storage/repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../../storage/repositories/space-registry-repository.js";

const TEST_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function requestJson(
  startedServer: { host: string; port: number },
  pathname: string,
  options: {
    body?: unknown;
    method?: "DELETE" | "GET" | "PATCH" | "POST";
  } = {},
): Promise<Response> {
  const requestInit: RequestInit = {
    method: options.method ?? "GET",
  };

  if (options.body !== undefined) {
    requestInit.headers = {
      "content-type": "application/json",
    };
    requestInit.body = JSON.stringify(options.body);
  }

  return fetch(`http://${startedServer.host}:${String(startedServer.port)}${pathname}`, requestInit);
}

async function postJson(
  startedServer: { host: string; port: number },
  pathname: string,
  body: unknown,
): Promise<Response> {
  return requestJson(startedServer, pathname, {
    method: "POST",
    body,
  });
}

async function patchJson(
  startedServer: { host: string; port: number },
  pathname: string,
  body: unknown,
): Promise<Response> {
  return requestJson(startedServer, pathname, {
    method: "PATCH",
    body,
  });
}

async function deleteJson(
  startedServer: { host: string; port: number },
  pathname: string,
  body: unknown,
): Promise<Response> {
  return requestJson(startedServer, pathname, {
    method: "DELETE",
    body,
  });
}

function createResolution(
  resolvedWorkingPath: string,
  git: GitInspection,
): ActiveMemorySpaceResolution {
  return {
    workingContext: {
      source: "cwd",
      selectedWorkingPath: resolvedWorkingPath,
      resolvedWorkingPath,
    },
    git,
    space: MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath,
      git,
    }),
  };
}

function createVector(entries: Array<[number, number]>): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);

  for (const [index, value] of entries) {
    vector[index] = value;
  }

  return vector;
}

async function startMockOllamaServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void> | void,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Mock Ollama server did not bind to a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
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

describe("startEngineServer", () => {
  it("serves health, stats, and spaces endpoints from the global database", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-engine-server-",
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
    });

    try {
      const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution("/workspace/project", {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T09:00:00.000Z",
        },
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "engine-stats-memory",
        spaceId: touchedSpace.space.id,
        memoryType: "fact",
        content: "Serve stats from the engine.",
      });
      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "engine-stats-job",
        spaceId: touchedSpace.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/engine-stats-job.jsonl",
      });
    } finally {
      bootstrapResult.database.close();
    }

    const startedServer = await startEngineServer({
      claudeMemoryHome,
      idleTimeoutMs: 10_000,
      pluginRoot: TEST_PLUGIN_ROOT,
      registerSignalHandlers: false,
    });

    testContext.after(async () => {
      await startedServer.close();
    });

    const healthResponse = await fetch(
      `http://${startedServer.host}:${String(startedServer.port)}/health`,
    );
    const statsResponse = await fetch(
      `http://${startedServer.host}:${String(startedServer.port)}/stats`,
    );
    const spacesResponse = await fetch(
      `http://${startedServer.host}:${String(startedServer.port)}/spaces`,
    );
    const persistedLock = await EngineLockService.readEngineLock({
      claudeMemoryHome,
    });
    const healthPayload = (await healthResponse.json()) as {
      api_contract_version: number;
      db_schema_version: number;
      engine_version: string;
    };
    const statsPayload = (await statsResponse.json()) as {
      idle_timeout_ms: number;
      online: boolean;
      queuedJobs: number;
      runningJobs: number;
      totalMemories: number;
      totalSpaces: number;
      uptime_ms: number;
    };
    const spacesPayload = (await spacesResponse.json()) as {
      spaces: Array<{ id: string; memoryCount: number; queuedJobCount: number }>;
    };

    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.db_schema_version, 5);
    assert.equal(healthPayload.api_contract_version, 1);
    assert.equal(typeof healthPayload.engine_version, "string");

    assert.equal(statsResponse.status, 200);
    assert.equal(statsPayload.totalSpaces, 1);
    assert.equal(statsPayload.totalMemories, 1);
    assert.equal(statsPayload.queuedJobs, 1);
    assert.equal(statsPayload.runningJobs, 0);
    assert.equal(statsPayload.idle_timeout_ms, 10_000);
    assert.equal(statsPayload.online, true);
    assert.equal(typeof statsPayload.uptime_ms, "number");

    assert.equal(spacesResponse.status, 200);
    assert.equal(spacesPayload.spaces.length, 1);
    const firstSpace = spacesPayload.spaces[0];

    assert.ok(firstSpace);
    assert.equal(firstSpace.memoryCount, 1);
    assert.equal(firstSpace.queuedJobCount, 1);

    assert.ok(persistedLock);
    assert.equal(persistedLock.port, startedServer.port);
  });

  it("shuts down after the idle timeout when no learning job is running", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-engine-idle-",
    );
    const startedServer = await startEngineServer({
      claudeMemoryHome,
      idleTimeoutMs: 250,
      pluginRoot: TEST_PLUGIN_ROOT,
      registerSignalHandlers: false,
    });

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
    });

    await startedServer.closed;

    const persistedLock = await EngineLockService.readEngineLock({
      claudeMemoryHome,
    });

    assert.equal(persistedLock, null);
  });

  it("does not idle-shutdown while a learning job is marked running", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-engine-running-job-",
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
    });

    try {
      const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution("/workspace/project", {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T10:00:00.000Z",
        },
      );

      LearningJobRepository.enqueueLearningJob(bootstrapResult.database, {
        id: "engine-running-job",
        spaceId: touchedSpace.space.id,
        rootPath: "/workspace/project",
        transcriptPath: "/tmp/engine-running-job.jsonl",
        state: "running",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-03-14T10:30:00.000Z",
      });
    } finally {
      bootstrapResult.database.close();
    }

    const startedServer = await startEngineServer({
      claudeMemoryHome,
      idleTimeoutMs: 250,
      pluginRoot: TEST_PLUGIN_ROOT,
      registerSignalHandlers: false,
    });

    testContext.after(async () => {
      await startedServer.close();
    });

    await sleep(500);

    const healthResponse = await fetch(
      `http://${startedServer.host}:${String(startedServer.port)}/health`,
    );

    assert.equal(healthResponse.status, 200);
  });

  it("handles touch, pinned, search, and job enqueue requests through the engine api", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-engine-api-",
    );
    const workspaceRoot = await createTempDirectory(
      "claude-memory-engine-workspace-",
    );
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
      await removePath(workspaceRoot);
      await removePath(claudeMemoryHome);
    });
    const seededState = (() => {
      try {
        const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
          bootstrapResult.database,
          {
            resolution: createResolution(resolvedWorkspaceRoot, {
              insideWorkTree: false,
            }),
            observedAt: "2026-03-14T11:00:00.000Z",
          },
        );
        const seededSpaceId = touchedSpace.space.id;

        MemoryRepository.createMemory(bootstrapResult.database, {
          id: "engine-api-memory",
          spaceId: seededSpaceId,
          memoryType: "rule",
          content: "Prefer the engine API for memory access.",
          tags: ["engine", "api"],
          isPinned: true,
        });

        return {
          spaceId: seededSpaceId,
        };
      } finally {
        bootstrapResult.database.close();
      }
    })();

    const startedServer = await startEngineServer({
      claudeMemoryHome,
      idleTimeoutMs: 10_000,
      pluginRoot: TEST_PLUGIN_ROOT,
      registerSignalHandlers: false,
    });

    testContext.after(async () => {
      await startedServer.close();
    });

    const touchResponse = await postJson(startedServer, "/spaces/touch", {
      context: {
        cwd: workspaceRoot,
      },
    });
    const pinnedResponse = await postJson(startedServer, "/memories/pinned", {
      context: {
        cwd: workspaceRoot,
      },
    });
    const searchResponse = await postJson(startedServer, "/memories/search", {
      context: {
        cwd: workspaceRoot,
      },
      query: "engine",
      limit: 5,
    });
    const learningJobResponse = await postJson(startedServer, "/learning-jobs", {
      context: {
        cwd: workspaceRoot,
      },
      transcript_path: "/tmp/engine-api-transcript.jsonl",
      last_assistant_message: "capture the memory delta",
      session_id: "session-123",
    });

    const touchPayload = (await touchResponse.json()) as {
      root: { rootPath: string };
      space: { id: string };
    };
    const pinnedPayload = (await pinnedResponse.json()) as {
      memories: Array<{ id: string; is_pinned: boolean }>;
      space: { space_id: string };
    };
    const searchPayload = (await searchResponse.json()) as {
      results: Array<{ id: string }>;
      space: { space_id: string };
    };
    const learningJobPayload = (await learningJobResponse.json()) as {
      job: { session_id: string | null; space_id: string; state: string };
    };

    assert.equal(touchResponse.status, 200);
    assert.equal(touchPayload.space.id, seededState.spaceId);
    assert.equal(touchPayload.root.rootPath, resolvedWorkspaceRoot);

    assert.equal(pinnedResponse.status, 200);
    assert.equal(pinnedPayload.space.space_id, seededState.spaceId);
    assert.equal(pinnedPayload.memories.length, 1);
    const firstPinnedMemory = pinnedPayload.memories[0];

    assert.ok(firstPinnedMemory);
    assert.equal(firstPinnedMemory.id, "engine-api-memory");
    assert.equal(firstPinnedMemory.is_pinned, true);

    assert.equal(searchResponse.status, 200);
    assert.equal(searchPayload.space.space_id, seededState.spaceId);
    assert.equal(searchPayload.results.length, 1);
    const firstSearchResult = searchPayload.results[0];

    assert.ok(firstSearchResult);
    assert.equal(firstSearchResult.id, "engine-api-memory");

    assert.equal(learningJobResponse.status, 201);
    assert.equal(learningJobPayload.job.space_id, seededState.spaceId);
    assert.equal(learningJobPayload.job.state, "pending");
    assert.equal(learningJobPayload.job.session_id, "session-123");
  });

  it("handles memory CRUD plus job and log listing through the engine api", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-engine-ui-api-",
    );
    const workspaceRoot = await createTempDirectory(
      "claude-memory-engine-ui-workspace-",
    );
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
      await removePath(workspaceRoot);
      await removePath(claudeMemoryHome);
    });

    const seededState = (() => {
      try {
        const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
          bootstrapResult.database,
          {
            resolution: createResolution(resolvedWorkspaceRoot, {
              insideWorkTree: false,
            }),
            observedAt: "2026-03-14T14:00:00.000Z",
          },
        );

        EventRepository.recordEvent(bootstrapResult.database, {
          spaceId: touchedSpace.space.id,
          rootPath: resolvedWorkspaceRoot,
          event: "seed-ui-log",
          kind: "api",
          status: "info",
          detail: "Seeded API event for UI log listing.",
        });

        return {
          spaceId: touchedSpace.space.id,
        };
      } finally {
        bootstrapResult.database.close();
      }
    })();

    const startedServer = await startEngineServer({
      claudeMemoryHome,
      idleTimeoutMs: 10_000,
      pluginRoot: TEST_PLUGIN_ROOT,
      registerSignalHandlers: false,
    });

    testContext.after(async () => {
      await startedServer.close();
    });

    const createMemoryResponse = await postJson(startedServer, "/memories/add", {
      context: {
        cwd: workspaceRoot,
      },
      memory_type: "rule",
      content: "Use the engine API for the UI data flow.",
      tags: ["ui", "engine"],
      is_pinned: true,
      path_matchers: ["src/ui/**/*.ts"],
    });
    const createdMemoryPayload = (await createMemoryResponse.json()) as {
      memory: {
        id: string;
        is_pinned: boolean;
        memory_type: string;
        path_matchers: string[];
        space_id: string;
      };
    };
    const listMemoriesResponse = await requestJson(
      startedServer,
      `/memories?space_id=${encodeURIComponent(seededState.spaceId)}`,
    );
    const listedMemoriesPayload = (await listMemoriesResponse.json()) as {
      memories: Array<{ id: string }>;
    };
    const updateMemoryResponse = await patchJson(
      startedServer,
      `/memories/${createdMemoryPayload.memory.id}`,
      {
        space_id: seededState.spaceId,
        memory_type: "decision",
        content: "Use the engine API for the UI and keep writes space-scoped.",
        tags: ["ui", "edited"],
        is_pinned: false,
        path_matchers: ["src/ui/editor.ts"],
      },
    );
    const updatedMemoryPayload = (await updateMemoryResponse.json()) as {
      memory: {
        content: string;
        id: string;
        is_pinned: boolean;
        memory_type: string;
        path_matchers: string[];
      };
    };
    const enqueueResponse = await postJson(startedServer, "/learning-jobs", {
      space_id: seededState.spaceId,
      transcript_path: "/tmp/ui-api-job.jsonl",
      last_assistant_message: "capture the UI memory changes",
      session_id: "session-ui",
    });
    const enqueuedJobPayload = (await enqueueResponse.json()) as {
      job: { id: string };
    };
    const listJobsResponse = await requestJson(
      startedServer,
      `/learning-jobs?space_id=${encodeURIComponent(seededState.spaceId)}`,
    );
    const listedJobsPayload = (await listJobsResponse.json()) as {
      jobs: Array<{ id: string; state: string }>;
    };
    const listLogsResponse = await requestJson(
      startedServer,
      `/logs?space_id=${encodeURIComponent(seededState.spaceId)}&kind=api`,
    );
    const listedLogsPayload = (await listLogsResponse.json()) as {
      events: Array<{ detail: string | null; event: string }>;
    };
    const deleteMemoryResponse = await deleteJson(
      startedServer,
      `/memories/${createdMemoryPayload.memory.id}`,
      {
        space_id: seededState.spaceId,
      },
    );
    const deleteMemoryPayload = (await deleteMemoryResponse.json()) as {
      deleted: boolean;
      memory_id: string;
    };
    const finalMemoriesResponse = await requestJson(
      startedServer,
      `/memories?space_id=${encodeURIComponent(seededState.spaceId)}`,
    );
    const finalMemoriesPayload = (await finalMemoriesResponse.json()) as {
      memories: Array<{ id: string }>;
    };

    assert.equal(createMemoryResponse.status, 201);
    assert.equal(createdMemoryPayload.memory.space_id, seededState.spaceId);
    assert.equal(createdMemoryPayload.memory.memory_type, "rule");
    assert.equal(createdMemoryPayload.memory.is_pinned, true);
    assert.deepEqual(createdMemoryPayload.memory.path_matchers, ["src/ui/**/*.ts"]);

    assert.equal(listMemoriesResponse.status, 200);
    assert.deepEqual(
      listedMemoriesPayload.memories.map((memory) => memory.id),
      [createdMemoryPayload.memory.id],
    );

    assert.equal(updateMemoryResponse.status, 200);
    assert.equal(updatedMemoryPayload.memory.id, createdMemoryPayload.memory.id);
    assert.equal(updatedMemoryPayload.memory.memory_type, "decision");
    assert.equal(updatedMemoryPayload.memory.is_pinned, false);
    assert.equal(
      updatedMemoryPayload.memory.content,
      "Use the engine API for the UI and keep writes space-scoped.",
    );
    assert.deepEqual(updatedMemoryPayload.memory.path_matchers, ["src/ui/editor.ts"]);

    assert.equal(enqueueResponse.status, 201);
    assert.equal(typeof enqueuedJobPayload.job.id, "string");

    assert.equal(listJobsResponse.status, 200);
    assert.deepEqual(
      listedJobsPayload.jobs.map((job) => job.id),
      [enqueuedJobPayload.job.id],
    );
    assert.equal(listedJobsPayload.jobs[0]?.state, "pending");

    assert.equal(listLogsResponse.status, 200);
    assert.deepEqual(
      listedLogsPayload.events.map((event) => event.event),
      ["seed-ui-log"],
    );
    assert.equal(
      listedLogsPayload.events[0]?.detail,
      "Seeded API event for UI log listing.",
    );

    assert.equal(deleteMemoryResponse.status, 200);
    assert.equal(deleteMemoryPayload.deleted, true);
    assert.equal(deleteMemoryPayload.memory_id, createdMemoryPayload.memory.id);

    assert.equal(finalMemoriesResponse.status, 200);
    assert.deepEqual(finalMemoriesPayload.memories, []);
  });

  it("uses Ollama embeddings for semantic memory writes and search when available", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-engine-semantic-home-",
    );
    const workspaceRoot = await createTempDirectory(
      "claude-memory-engine-semantic-workspace-",
    );
    const originalOllamaUrl = process.env["MEMORIES_OLLAMA_URL"];
    let embedRequestCount = 0;
    const mockOllamaServer = await startMockOllamaServer(
      async (request, response) => {
        const requestBodyChunks: Buffer[] = [];

        for await (const chunk of request) {
          const bufferChunk = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk), "utf8");

          requestBodyChunks.push(bufferChunk);
        }

        const requestBody = JSON.parse(
          Buffer.concat(requestBodyChunks).toString("utf8"),
        ) as { input: string };
        const embedding =
          requestBody.input === "Find the semantic-only memory."
            ? createVector([[0, 1]])
            : createVector([[0, 1]]);

        embedRequestCount += 1;
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            embeddings: [embedding],
          }),
        );
      },
    );

    process.env["MEMORIES_OLLAMA_URL"] = mockOllamaServer.baseUrl;

    testContext.after(async () => {
      if (originalOllamaUrl === undefined) {
        delete process.env["MEMORIES_OLLAMA_URL"];
      } else {
        process.env["MEMORIES_OLLAMA_URL"] = originalOllamaUrl;
      }

      await mockOllamaServer.close();
      await removePath(workspaceRoot);
      await removePath(claudeMemoryHome);
    });

    const startedServer = await startEngineServer({
      claudeMemoryHome,
      idleTimeoutMs: 10_000,
      pluginRoot: TEST_PLUGIN_ROOT,
      registerSignalHandlers: false,
    });

    testContext.after(async () => {
      await startedServer.close();
    });

    const createMemoryResponse = await postJson(startedServer, "/memories/add", {
      context: {
        cwd: workspaceRoot,
      },
      memory_type: "fact",
      content: "Semantic only memory content.",
      tags: [],
    });
    const createdMemoryPayload = (await createMemoryResponse.json()) as {
      memory: { id: string };
    };
    const searchResponse = await postJson(startedServer, "/memories/search", {
      context: {
        cwd: workspaceRoot,
      },
      query: "Find the semantic-only memory.",
      limit: 5,
    });
    const searchPayload = (await searchResponse.json()) as {
      results: Array<{ id: string; matched_by: string[]; source: string }>;
    };

    assert.equal(createMemoryResponse.status, 201);
    assert.equal(searchResponse.status, 200);
    assert.equal(embedRequestCount, 2);
    assert.deepEqual(
      searchPayload.results.map((result) => result.id),
      [createdMemoryPayload.memory.id],
    );
    const firstSearchResult = searchPayload.results[0];

    assert.ok(firstSearchResult);
    assert.deepEqual(firstSearchResult.matched_by, ["semantic"]);
    assert.equal(firstSearchResult.source, "semantic");
  });
});
