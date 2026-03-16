import type { StorageMigration } from "../types/database.js";

export const learningJobsAndEventsMigration: StorageMigration = {
  version: 4,
  name: "learning-jobs-and-events",
  sql: `
    CREATE TABLE IF NOT EXISTS learning_jobs (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      last_assistant_message TEXT,
      session_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'running', 'completed', 'failed', 'skipped')),
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      error_text TEXT,
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      space_id TEXT REFERENCES memory_spaces(id) ON DELETE SET NULL,
      root_path TEXT,
      event TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('engine', 'space', 'memory', 'retrieval', 'learning_job', 'hook', 'mcp', 'ui', 'api', 'storage')),
      status TEXT NOT NULL CHECK (status IN ('info', 'success', 'warning', 'error')),
      session_id TEXT,
      memory_id TEXT,
      job_id TEXT,
      detail TEXT,
      data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json))
    );
  `,
};
