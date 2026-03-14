import type { StorageMigration } from "../types/database.js";

export const memoriesAndPathMatchersMigration: StorageMigration = {
  version: 2,
  name: "memories-and-path-matchers",
  sql: `
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
      memory_type TEXT NOT NULL CHECK (memory_type IN ('fact', 'rule', 'decision', 'episode')),
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
      is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_path_matchers (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      path_matcher TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
};
