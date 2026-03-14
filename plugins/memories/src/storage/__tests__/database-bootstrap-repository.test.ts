import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { SqliteService } from "../sqlite-service.js";

describe("DatabaseBootstrapRepository", () => {
  it("bootstraps the global database and applies the first schema migration", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-");

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
    });

    try {
      const tableRows = bootstrapResult.database
        .prepare(
          "select name, type from sqlite_master where name in ('memory_spaces', 'space_roots', 'idx_space_roots_space_id_root_path') order by type, name;",
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
      assert.equal(bootstrapResult.schemaVersion, 1);
      assert.equal(SqliteService.readUserVersion(bootstrapResult.database), 1);
      assert.deepEqual(tableRows, [
        { name: "idx_space_roots_space_id_root_path", type: "index" },
        { name: "memory_spaces", type: "table" },
        { name: "space_roots", type: "table" },
      ]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("keeps bootstrap idempotent for an already-migrated database", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-repeat-");
    const firstBootstrap = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
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
    });

    try {
      const row = secondBootstrap.database
        .prepare("select count(*) as count from memory_spaces;")
        .get() as { count: number };

      assert.equal(secondBootstrap.schemaVersion, 1);
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
        }),
      /newer than supported version/u,
    );
  });

  it("enforces the memory_spaces origin invariants from the plan", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-bootstrap-checks-");
    const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
      claudeMemoryHome: tempDirectory,
      currentWorkingDirectory: "/unused/current-working-directory",
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
