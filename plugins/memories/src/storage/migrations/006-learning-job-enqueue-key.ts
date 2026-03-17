import type { StorageMigration } from "../types/database.js";

export const learningJobEnqueueKeyMigration: StorageMigration = {
  version: 6,
  name: "learning-job-enqueue-key",
  sql: `
    ALTER TABLE learning_jobs ADD COLUMN enqueue_key TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_jobs_enqueue_key_active
      ON learning_jobs(enqueue_key)
      WHERE enqueue_key IS NOT NULL
        AND state IN ('pending', 'leased', 'running');
  `,
};
