import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { CLAUDE_MEMORY_VERSION } from "../../shared/constants/version.js";
import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import { EngineLockService } from "../../shared/services/engine-lock-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";
import { MemoryRepository } from "../../storage/repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../../storage/repositories/space-registry-repository.js";
import {
  handleJsonRpcMessage,
  serializeJsonRpcMessage,
} from "../search-server.js";
import {
  ENGINE_NODE_ARGUMENTS,
  SOURCE_ENGINE_ENTRYPOINT,
  TEST_PLUGIN_ROOT,
  stopRunningEngine,
} from "../../hooks/__tests__/helpers.js";

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

describe("search-server", () => {
  it("initializes with the requested MCP protocol version", async () => {
    const response = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
      },
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "memories",
          version: CLAUDE_MEMORY_VERSION,
        },
      },
    });
  });

  it("lists the recall tool", async () => {
    const response = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "recall",
            description:
              "Use `recall` before acting on non-trivial work, and use it again when project context changes. Pinned startup context is only a subset. This searches only the current active memory space.",
            inputSchema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  minLength: 1,
                },
                related_paths: {
                  type: "array",
                  items: {
                    type: "string",
                    minLength: 1,
                  },
                },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
  });

  it("returns recall markdown for the active space and auto-starts the engine", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory("claude-memory-mcp-home-");
    const workspacePath = await createTempDirectory("claude-memory-mcp-workspace-");
    const resolvedWorkspacePath = await realpath(workspacePath);
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });
    const originalWorkingDirectory = process.cwd();
    const originalProjectDirectory = process.env["CLAUDE_PROJECT_DIR"];

    testContext.after(async () => {
      if (originalProjectDirectory === undefined) {
        delete process.env["CLAUDE_PROJECT_DIR"];
      } else {
        process.env["CLAUDE_PROJECT_DIR"] = originalProjectDirectory;
      }

      process.chdir(originalWorkingDirectory);
      await stopRunningEngine(claudeMemoryHome);
      await removePath(claudeMemoryHome);
      await removePath(workspacePath);
    });

    try {
      const touchedSpace = SpaceRegistryRepository.touchResolvedMemorySpace(
        bootstrapResult.database,
        {
          resolution: createResolution(resolvedWorkspacePath, {
            insideWorkTree: false,
          }),
          observedAt: "2026-03-14T13:00:00.000Z",
        },
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "mcp-recall-memory",
        spaceId: touchedSpace.space.id,
        memoryType: "decision",
        content: "Prefer the engine API for MCP recall requests.",
        tags: ["mcp", "engine"],
        pathMatchers: ["src/mcp/**/*.ts"],
      });
    } finally {
      bootstrapResult.database.close();
    }

    process.chdir(workspacePath);
    process.env["CLAUDE_PROJECT_DIR"] = workspacePath;

    const response = await handleJsonRpcMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "recall",
          arguments: {
            query: "engine",
            related_paths: ["src/mcp/search-server.ts"],
          },
        },
      },
      {
        bootTimeoutMs: 10_000,
        claudeMemoryHome,
        engineEntrypoint: SOURCE_ENGINE_ENTRYPOINT,
        engineNodeArguments: ENGINE_NODE_ARGUMENTS,
        pluginRoot: TEST_PLUGIN_ROOT,
      },
    );
    const persistedLock = await EngineLockService.readEngineLockIfProcessAlive({
      claudeMemoryHome,
    });
    const toolResult = response as {
      id: number;
      jsonrpc: "2.0";
      result: { content: Array<{ text: string; type: string }>; isError: boolean };
    };

    assert.equal(toolResult.jsonrpc, "2.0");
    assert.equal(toolResult.id, 3);
    assert.equal(toolResult.result.isError, false);
    const firstContent = toolResult.result.content[0];

    assert.ok(firstContent);
    assert.equal(firstContent.type, "text");
    assert.ok(persistedLock);
    const resultText = firstContent.text;

    assert.match(resultText, /# Claude Memory Recall/u);
    assert.match(resultText, /Active space kind: `directory`/u);
    assert.ok(resultText.includes(`Active space: \`${resolvedWorkspacePath}\``));
    assert.match(resultText, /Prefer the engine API for MCP recall requests\./u);
    assert.match(resultText, /Path matchers: `src\/mcp\/\*\*\/\*\.ts`/u);
  });

  it("returns a JSON-RPC error when recall arguments are invalid", async () => {
    const response = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "recall",
        arguments: {
          query: "",
        },
      },
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32602,
        message: "Too small: expected string to have >=1 characters",
      },
    });
  });

  it("returns a JSON-RPC error for unknown methods", async () => {
    const response = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/unknown",
    });

    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 5,
      error: {
        code: -32601,
        message: 'Method "tools/unknown" is not supported.',
      },
    });
  });

  it("serializes JSON-RPC responses with Content-Length framing", () => {
    const serializedMessage = serializeJsonRpcMessage({
      jsonrpc: "2.0",
      id: 6,
      result: {
        ok: true,
      },
    });

    assert.match(serializedMessage, /^Content-Length: \d+\r\n\r\n/u);
    assert.match(serializedMessage, /"jsonrpc":"2\.0"/u);
    assert.match(serializedMessage, /"id":6/u);
    assert.match(serializedMessage, /"ok":true/u);
  });
});
