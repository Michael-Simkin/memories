import type { StorageMigration } from "../types/database.js";

export const memoryFtsMigration: StorageMigration = {
  version: 3,
  name: "memory-fts",
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      tags_text
    );
  `,
};
