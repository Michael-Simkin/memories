import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";
import { MemoryRepository } from "../../storage/repositories/memory-repository.js";
import { SpaceRegistryRepository } from "../../storage/repositories/space-registry-repository.js";
import { handleSessionStartHook } from "../session-start.js";
import type { SessionStartHookInput } from "../types/session-start.js";
import {
  ENGINE_NODE_ARGUMENTS,
  SOURCE_ENGINE_ENTRYPOINT,
  TEST_PLUGIN_ROOT,
  stopRunningEngine,
} from "./helpers.js";

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

function createSessionStartHookInput(
  workspacePath: string,
  overrides: Partial<SessionStartHookInput> = {},
): SessionStartHookInput {
  return {
    hook_event_name: "SessionStart",
    cwd: workspacePath,
    session_id: "session-1",
    transcript_path: path.join(workspacePath, "transcript.jsonl"),
    ...overrides,
  };
}

describe("handleSessionStartHook", () => {
  it("returns a UI system message and pinned startup context for the active space", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-session-start-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-session-start-workspace-",
    );
    const resolvedWorkspacePath = await realpath(workspacePath);
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
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
          observedAt: "2026-03-14T12:00:00.000Z",
        },
      );

      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "startup-pinned-memory",
        spaceId: touchedSpace.space.id,
        memoryType: "rule",
        content: "Always run the project tests before finalizing changes.",
        tags: ["startup", "tests"],
        isPinned: true,
        pathMatchers: ["src/**/*.ts"],
      });
      MemoryRepository.createMemory(bootstrapResult.database, {
        id: "startup-hidden-memory",
        spaceId: touchedSpace.space.id,
        memoryType: "fact",
        content: "This memory should stay out of the startup block.",
        isPinned: false,
      });
    } finally {
      bootstrapResult.database.close();
    }

    const hookOutput = await handleSessionStartHook(
      createSessionStartHookInput(workspacePath),
      {
        bootTimeoutMs: 10_000,
        claudeMemoryHome,
        engineEntrypoint: SOURCE_ENGINE_ENTRYPOINT,
        engineNodeArguments: ENGINE_NODE_ARGUMENTS,
        pluginRoot: TEST_PLUGIN_ROOT,
      },
    );

    assert.match(
      hookOutput.systemMessage,
      /^Claude Memory UI: http:\/\/127\.0\.0\.1:\d+\/ui\?cwd=/u,
    );
    assert.equal(hookOutput.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(
      hookOutput.hookSpecificOutput.additionalContext,
      /Active space kind: `directory`/u,
    );
    assert.ok(
      hookOutput.hookSpecificOutput.additionalContext.includes(
        `Active space: \`${resolvedWorkspacePath}\``,
      ),
    );
    assert.match(
      hookOutput.hookSpecificOutput.additionalContext,
      /Always run the project tests before finalizing changes\./u,
    );
    assert.match(
      hookOutput.hookSpecificOutput.additionalContext,
      /Path matchers: `src\/\*\*\/\*\.ts`/u,
    );
    assert.doesNotMatch(
      hookOutput.hookSpecificOutput.additionalContext,
      /This memory should stay out of the startup block\./u,
    );
  });
});
