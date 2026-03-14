import type { StorageMigration } from "../types/database.js";

export const memorySpacesAndSpaceRootsMigration: StorageMigration = {
  version: 1,
  name: "memory-spaces-and-space-roots",
  sql: `
    CREATE TABLE IF NOT EXISTS memory_spaces (
      id TEXT PRIMARY KEY,
      space_key TEXT NOT NULL UNIQUE,
      space_kind TEXT NOT NULL CHECK (space_kind IN ('remote_repo', 'directory')),
      display_name TEXT NOT NULL,
      last_seen_root_path TEXT NOT NULL,
      origin_url TEXT,
      origin_url_normalized TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      CHECK (
        (space_kind = 'remote_repo' AND origin_url IS NOT NULL AND origin_url_normalized IS NOT NULL)
        OR
        (space_kind = 'directory' AND origin_url IS NULL AND origin_url_normalized IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS space_roots (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      root_kind TEXT NOT NULL CHECK (root_kind IN ('git_worktree', 'directory_root')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_space_roots_space_id_root_path
      ON space_roots(space_id, root_path);
  `,
};
