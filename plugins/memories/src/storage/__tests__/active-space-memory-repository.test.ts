import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createTempDirectory,
  initializeGitRepository,
  removePath,
  runGitCommand,
} from "../../shared/__tests__/helpers.js";
import { ActiveSpaceMemoryRepository } from "../repositories/active-space-memory-repository.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";

describe("ActiveSpaceMemoryRepository", () => {
  it("creates and reads pinned memories for a directory-scoped context", async (testContext) => {
    const workspacePath = await createTempDirectory(
      "claude-memory-active-space-pinned-",
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
      await removePath(workspacePath);
    });

    const createdMemory = await ActiveSpaceMemoryRepository.createMemory(
      bootstrapResult.database,
      {
        context: {
          cwd: workspacePath,
        },
        id: "active-pinned",
        memoryType: "rule",
        content: "Pinned result for this active space.",
        tags: ["startup"],
        isPinned: true,
      },
    );

    const pinnedResult = await ActiveSpaceMemoryRepository.listPinnedMemories(
      bootstrapResult.database,
      {
        context: {
          cwd: workspacePath,
        },
      },
    );

    assert.equal(pinnedResult.space.space_id, createdMemory.space_id);
    assert.deepEqual(
      pinnedResult.memories.map((memory) => memory.id),
      ["active-pinned"],
    );
  });

  it("shares one remote-scoped space across separate clones with the same origin", async (testContext) => {
    const firstRepositoryPath = await createTempDirectory(
      "claude-memory-active-space-remote-a-",
    );
    const secondRepositoryPath = await createTempDirectory(
      "claude-memory-active-space-remote-b-",
    );
    const secondNestedPath = path.join(secondRepositoryPath, "packages", "app");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
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

    const createdMemory = await ActiveSpaceMemoryRepository.createMemory(
      bootstrapResult.database,
      {
        context: {
          cwd: firstRepositoryPath,
        },
        id: "shared-remote-memory",
        memoryType: "fact",
        content: "Remote-scoped memories should be shared across clones.",
        tags: ["release"],
        pathMatchers: ["packages/app/src/index.ts"],
      },
    );

    const searchResult = await ActiveSpaceMemoryRepository.searchMemories(
      bootstrapResult.database,
      {
        context: {
          cwd: secondNestedPath,
        },
        query: "release",
        relatedPaths: ["packages/app/src/index.ts:10"],
      },
    );
    const counts = bootstrapResult.database
      .prepare(
        "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
      )
      .get() as { root_count: number; space_count: number };

    assert.equal(searchResult.space.space_id, createdMemory.space_id);
    assert.deepEqual(
      searchResult.results.map((result) => result.id),
      ["shared-remote-memory"],
    );
    assert.deepEqual(searchResult.results[0]?.matched_by, ["path", "lexical"]);
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
  });

  it("requires either an explicit space id or a resolvable context", async () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    try {
      await assert.rejects(
        () =>
          ActiveSpaceMemoryRepository.listPinnedMemories(
            bootstrapResult.database,
            {},
          ),
        /requires either an explicit spaceId or a resolvable context/u,
      );
    } finally {
      bootstrapResult.database.close();
    }
  });
});
