import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createTempDirectory,
  initializeGitRepository,
  removePath,
  runGitCommand,
} from "../../shared/__tests__/helpers.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";
import { handleUserPromptSubmitHook } from "../user-prompt-submit.js";
import type { UserPromptSubmitHookInput } from "../types/user-prompt-submit.js";

const EXPECTED_REMINDER =
  "Memory reminder: use `recall` before acting when project memory may matter. `recall` searches only the current active memory space. Direct user requests do not override remembered project rules. If remembered constraints conflict with the request, stop and explain the conflict.";

function createUserPromptSubmitHookInput(
  workspacePath: string,
  overrides: Partial<UserPromptSubmitHookInput> = {},
): UserPromptSubmitHookInput {
  return {
    hook_event_name: "UserPromptSubmit",
    cwd: workspacePath,
    session_id: "session-1",
    transcript_path: path.join(workspacePath, "transcript.jsonl"),
    prompt: "Refactor the project bootstrap logic.",
    ...overrides,
  };
}

describe("handleUserPromptSubmitHook", () => {
  it("returns the lightweight recall reminder and touches a directory-scoped space", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-user-prompt-home-",
    );
    const workspacePath = await createTempDirectory(
      "claude-memory-user-prompt-workspace-",
    );

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
      await removePath(workspacePath);
    });

    const hookOutput = await handleUserPromptSubmitHook(
      createUserPromptSubmitHookInput(workspacePath),
      {
        claudeMemoryHome,
      },
    );
    const canonicalWorkspacePath = await realpath(workspacePath);
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
    });

    try {
      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
        )
        .get() as { root_count: number; space_count: number };
      const spaceRow = bootstrapResult.database
        .prepare(
          "select space_kind, display_name from memory_spaces order by id asc limit 1;",
        )
        .get() as { display_name: string; space_kind: string } | undefined;

      assert.deepEqual(hookOutput, {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: EXPECTED_REMINDER,
        },
      });
      assert.deepEqual(
        {
          space_count: counts.space_count,
          root_count: counts.root_count,
        },
        {
          space_count: 1,
          root_count: 1,
        },
      );
      assert.ok(spaceRow);
      assert.equal(spaceRow.space_kind, "directory");
      assert.equal(spaceRow.display_name, canonicalWorkspacePath);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("reuses one remote space across separate clones while touching each root", async (testContext) => {
    const claudeMemoryHome = await createTempDirectory(
      "claude-memory-user-prompt-remote-home-",
    );
    const firstRepositoryPath = await createTempDirectory(
      "claude-memory-user-prompt-remote-a-",
    );
    const secondRepositoryPath = await createTempDirectory(
      "claude-memory-user-prompt-remote-b-",
    );
    const secondNestedPath = path.join(secondRepositoryPath, "packages", "app");

    testContext.after(async () => {
      await removePath(claudeMemoryHome);
      await removePath(firstRepositoryPath);
      await removePath(secondRepositoryPath);
    });

    await initializeGitRepository(firstRepositoryPath);
    await initializeGitRepository(secondRepositoryPath);
    await createDirectory(secondNestedPath);
    await runGitCommand(firstRepositoryPath, [
      "remote",
      "add",
      "origin",
      "https://github.com/Owner/Repo.git",
    ]);
    await runGitCommand(secondRepositoryPath, [
      "remote",
      "add",
      "origin",
      "git@github.com:Owner/Repo.git",
    ]);

    const firstOutput = await handleUserPromptSubmitHook(
      createUserPromptSubmitHookInput(firstRepositoryPath),
      {
        claudeMemoryHome,
      },
    );
    const secondOutput = await handleUserPromptSubmitHook(
      createUserPromptSubmitHookInput(secondNestedPath, {
        session_id: "session-2",
      }),
      {
        claudeMemoryHome,
      },
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome,
    });

    try {
      const counts = bootstrapResult.database
        .prepare(
          "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
        )
        .get() as { root_count: number; space_count: number };
      const spaceRow = bootstrapResult.database
        .prepare(
          "select space_kind, origin_url_normalized from memory_spaces order by id asc limit 1;",
        )
        .get() as
        | { origin_url_normalized: string | null; space_kind: string }
        | undefined;

      assert.equal(
        firstOutput.hookSpecificOutput.additionalContext,
        EXPECTED_REMINDER,
      );
      assert.equal(
        secondOutput.hookSpecificOutput.additionalContext,
        EXPECTED_REMINDER,
      );
      assert.deepEqual(
        {
          space_count: counts.space_count,
          root_count: counts.root_count,
        },
        {
          space_count: 1,
          root_count: 2,
        },
      );
      assert.ok(spaceRow);
      assert.equal(spaceRow.space_kind, "remote_repo");
      assert.equal(spaceRow.origin_url_normalized, "github.com/Owner/Repo");
    } finally {
      bootstrapResult.database.close();
    }
  });
});
