import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createTempDirectory,
  removePath,
} from "../../shared/__tests__/helpers.js";
import { SqliteService } from "../sqlite-service.js";

describe("SqliteService", () => {
  it("creates the database parent directory and supports basic SQL operations", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-sqlite-");
    const databasePath = path.join(tempDirectory, "nested", "memory.db");

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    const database = SqliteService.openDatabase(databasePath);

    try {
      database.exec(
        "create table memories (id integer primary key, content text); insert into memories(content) values ('hello');",
      );

      const row = database
        .prepare("select count(*) as count from memories")
        .get() as { count: number };
      const foreignKeys = database.prepare("pragma foreign_keys;").get() as {
        foreign_keys: number;
      };
      const journalMode = database.prepare("pragma journal_mode;").get() as {
        journal_mode: string;
      };

      assert.equal(row.count, 1);
      assert.equal(foreignKeys.foreign_keys, 1);
      assert.equal(journalMode.journal_mode, "wal");
      await access(databasePath);
    } finally {
      database.close();
    }
  });
});
