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
import { MemoryRepository } from "../repositories/memory-repository.js";

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

  it("updates and deletes one remote-scoped memory across separate clones with the same origin", async (testContext) => {
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

    const updatedMemory = await ActiveSpaceMemoryRepository.updateMemory(
      bootstrapResult.database,
      {
        context: {
          cwd: secondNestedPath,
        },
        memoryId: "shared-remote-memory",
        memoryType: "decision",
        content: "Updated from another clone with the same origin.",
        tags: ["release", "deploy"],
        updatedAt: "2026-03-14T12:20:00.000Z",
      },
    );
    const searchResult = await ActiveSpaceMemoryRepository.searchMemories(
      bootstrapResult.database,
      {
        context: {
          cwd: secondNestedPath,
        },
        query: "deploy",
        relatedPaths: ["packages/app/src/index.ts:10"],
      },
    );
    await ActiveSpaceMemoryRepository.deleteMemory(bootstrapResult.database, {
      context: {
        cwd: secondNestedPath,
      },
      memoryId: "shared-remote-memory",
    });
    const counts = bootstrapResult.database
      .prepare(
        "select (select count(*) from memory_spaces) as space_count, (select count(*) from space_roots) as root_count;",
      )
      .get() as { root_count: number; space_count: number };
    const deletedMemory = MemoryRepository.getMemoryById(
      bootstrapResult.database,
      "shared-remote-memory",
    );

    assert.equal(searchResult.space.space_id, createdMemory.space_id);
    assert.equal(updatedMemory.memory_type, "decision");
    assert.equal(updatedMemory.content, "Updated from another clone with the same origin.");
    assert.deepEqual(updatedMemory.tags, ["release", "deploy"]);
    assert.deepEqual(
      searchResult.results.map((result) => result.id),
      ["shared-remote-memory"],
    );
    assert.deepEqual(searchResult.results[0]?.matched_by, ["path", "lexical"]);
    assert.equal(deletedMemory, null);
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

  it("rejects updates and deletes when the resolved context points at another space", async (testContext) => {
    const firstWorkspacePath = await createTempDirectory(
      "claude-memory-active-space-dir-a-",
    );
    const secondWorkspacePath = await createTempDirectory(
      "claude-memory-active-space-dir-b-",
    );
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
    });

    testContext.after(async () => {
      bootstrapResult.database.close();
      await removePath(firstWorkspacePath);
      await removePath(secondWorkspacePath);
    });

    await ActiveSpaceMemoryRepository.createMemory(bootstrapResult.database, {
      context: {
        cwd: firstWorkspacePath,
      },
      id: "guarded-memory",
      memoryType: "rule",
      content: "Only the active space may mutate this memory.",
      tags: ["guard"],
    });

    await assert.rejects(
      () =>
        ActiveSpaceMemoryRepository.updateMemory(bootstrapResult.database, {
          context: {
            cwd: secondWorkspacePath,
          },
          memoryId: "guarded-memory",
          content: "This should fail.",
        }),
      /does not belong to active space/u,
    );
    await assert.rejects(
      () =>
        ActiveSpaceMemoryRepository.deleteMemory(bootstrapResult.database, {
          context: {
            cwd: secondWorkspacePath,
          },
          memoryId: "guarded-memory",
        }),
      /does not belong to active space/u,
    );

    const guardedMemory = MemoryRepository.getMemoryById(
      bootstrapResult.database,
      "guarded-memory",
    );

    assert.ok(guardedMemory);
    assert.equal(guardedMemory.content, "Only the active space may mutate this memory.");
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
