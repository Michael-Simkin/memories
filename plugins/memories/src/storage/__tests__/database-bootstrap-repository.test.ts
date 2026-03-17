import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { SqliteService } from "../sqlite-service.js";

const TEST_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function createUnitVector(index: number): number[] {
  const embedding = Array.from({ length: 1024 }, () => 0);
  embedding[index] = 1;

  return embedding;
}

describe("DatabaseBootstrapRepository", () => {
  it("bootstraps the global database and applies migrations through the current schema version", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-");

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    try {
      const tableRows = bootstrapResult.database
        .prepare(
          "select name, type from sqlite_master where name in ('memory_spaces', 'space_roots', 'memories', 'memory_path_matchers', 'memory_fts', 'learning_jobs', 'events', 'vec_memory', 'idx_space_roots_space_id_root_path') order by type, name;",
        )
        .all()
        .map((row) => ({
          name: (row as { name: string }).name,
          type: (row as { type: string }).type,
        }));

      assert.equal(
        bootstrapResult.databasePath,
        path.join(tempDirectory, "memory.db"),
      );
      assert.equal(bootstrapResult.schemaVersion, 5);
      assert.equal(SqliteService.readUserVersion(bootstrapResult.database), 5);
      assert.deepEqual(tableRows, [
        { name: "idx_space_roots_space_id_root_path", type: "index" },
        { name: "events", type: "table" },
        { name: "learning_jobs", type: "table" },
        { name: "memories", type: "table" },
        { name: "memory_fts", type: "table" },
        { name: "memory_path_matchers", type: "table" },
        { name: "memory_spaces", type: "table" },
        { name: "space_roots", type: "table" },
        { name: "vec_memory", type: "table" },
      ]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("loads the vendored sqlite-vec extension and executes vec queries when requested", () => {
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      databasePath: ":memory:",
      loadVectorExtension: true,
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    try {
      const versionRow = bootstrapResult.database
        .prepare("select vec_version() as version;")
        .get() as { version: string };

      bootstrapResult.database
        .prepare("DELETE FROM vec_memory;")
        .run();
      bootstrapResult.database
        .prepare("INSERT INTO vec_memory(memory_id, embedding) VALUES (?, ?);")
        .run("memory-a", JSON.stringify(createUnitVector(0)));
      bootstrapResult.database
        .prepare("INSERT INTO vec_memory(memory_id, embedding) VALUES (?, ?);")
        .run("memory-b", JSON.stringify(createUnitVector(1)));

      const nearestRows = bootstrapResult.database
        .prepare(`
          SELECT memory_id, distance
          FROM vec_memory
          WHERE embedding MATCH ? AND k = 2
          ORDER BY distance ASC;
        `)
        .all(JSON.stringify(createUnitVector(0)))
        .map((row) => ({
          memory_id: (row as { memory_id: string }).memory_id,
          distance: (row as { distance: number }).distance,
        }));

      assert.match(versionRow.version, /^v/u);
      assert.deepEqual(nearestRows, [
        { memory_id: "memory-a", distance: 0 },
        { memory_id: "memory-b", distance: 1 },
      ]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("fails bootstrap with an actionable error when sqlite-vec is requested but missing", async (testContext) => {
    const tempPluginRoot = await createTempDirectory(
      "claude-memory-missing-plugin-root-",
    );

    testContext.after(async () => {
      await removePath(tempPluginRoot);
    });

    assert.throws(
      () =>
        DatabaseBootstrapRepository.bootstrapDatabase({
          databasePath: ":memory:",
          loadVectorExtension: true,
          pluginRoot: tempPluginRoot,
        }),
      /missing or unreadable/u,
    );
  });

  it("keeps bootstrap idempotent for an already-migrated database", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-repeat-");
    const firstBootstrap = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    try {
      firstBootstrap.database.exec(`
        INSERT INTO memory_spaces (
          id,
          space_key,
          space_kind,
          display_name,
          last_seen_root_path,
          origin_url,
          origin_url_normalized,
          created_at,
          updated_at,
          last_seen_at
        ) VALUES (
          'space-1',
          'space-key-1',
          'directory',
          'Demo space',
          '/tmp/demo',
          NULL,
          NULL,
          '2026-03-14T00:00:00.000Z',
          '2026-03-14T00:00:00.000Z',
          '2026-03-14T00:00:00.000Z'
        );
      `);
    } finally {
      firstBootstrap.database.close();
    }

    const secondBootstrap = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    try {
      const row = secondBootstrap.database
        .prepare("select count(*) as count from memory_spaces;")
        .get() as { count: number };

      assert.equal(secondBootstrap.schemaVersion, 5);
      assert.equal(row.count, 1);
    } finally {
      secondBootstrap.database.close();
    }
  });

  it("rejects databases with a newer schema version than this code supports", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-newer-");
    const databasePath = path.join(tempDirectory, "memory.db");
    const database = SqliteService.openDatabase(databasePath);

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    try {
      SqliteService.writeUserVersion(database, 99);
    } finally {
      database.close();
    }

    assert.throws(
      () =>
        DatabaseBootstrapRepository.bootstrapDatabase({
          databasePath,
          pluginRoot: TEST_PLUGIN_ROOT,
        }),
      /newer than supported version/u,
    );
  });

  it("enforces the memory_spaces origin invariants from the plan", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-checks-");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
      pluginRoot: TEST_PLUGIN_ROOT,
    });

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    try {
      bootstrapResult.database.exec(`
        INSERT INTO memory_spaces (
          id,
          space_key,
          space_kind,
          display_name,
          last_seen_root_path,
          origin_url,
          origin_url_normalized,
          created_at,
          updated_at,
          last_seen_at
        ) VALUES (
          'directory-space',
          'directory-key',
          'directory',
          'Directory space',
          '/tmp/directory',
          NULL,
          NULL,
          '2026-03-14T00:00:00.000Z',
          '2026-03-14T00:00:00.000Z',
          '2026-03-14T00:00:00.000Z'
        );
      `);

      assert.throws(
        () => {
          bootstrapResult.database.exec(`
            INSERT INTO memory_spaces (
              id,
              space_key,
              space_kind,
              display_name,
              last_seen_root_path,
              origin_url,
              origin_url_normalized,
              created_at,
              updated_at,
              last_seen_at
            ) VALUES (
              'invalid-remote-space',
              'invalid-remote-key',
              'remote_repo',
              'Broken remote',
              '/tmp/remote',
              NULL,
              NULL,
              '2026-03-14T00:00:00.000Z',
              '2026-03-14T00:00:00.000Z',
              '2026-03-14T00:00:00.000Z'
            );
          `);
        },
        /constraint/u,
      );

      assert.throws(
        () => {
          bootstrapResult.database.exec(`
            INSERT INTO memory_spaces (
              id,
              space_key,
              space_kind,
              display_name,
              last_seen_root_path,
              origin_url,
              origin_url_normalized,
              created_at,
              updated_at,
              last_seen_at
            ) VALUES (
              'invalid-directory-space',
              'invalid-directory-key',
              'directory',
              'Broken directory',
              '/tmp/directory',
              'https://github.com/Owner/Repo.git',
              'github.com/Owner/Repo',
              '2026-03-14T00:00:00.000Z',
              '2026-03-14T00:00:00.000Z',
              '2026-03-14T00:00:00.000Z'
            );
          `);
        },
        /constraint/u,
      );
    } finally {
      bootstrapResult.database.close();
    }
  });
});
