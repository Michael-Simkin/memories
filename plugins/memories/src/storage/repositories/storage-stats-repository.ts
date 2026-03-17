import type { DatabaseSync } from "node:sqlite";

import type { StorageStats } from "../types/stats.js";

export class StorageStatsRepository {
  static getStats(database: DatabaseSync): StorageStats {
    const row = database
      .prepare(
        `SELECT
          (SELECT count(*) FROM memory_spaces) AS total_spaces,
          (SELECT count(*) FROM memories) AS total_memories,
          (SELECT count(*) FROM learning_jobs WHERE state IN ('pending', 'leased')) AS queued_jobs,
          (SELECT count(*) FROM learning_jobs WHERE state = 'running') AS running_jobs`,
      )
      .get() as {
        queued_jobs: number;
        running_jobs: number;
        total_memories: number;
        total_spaces: number;
      };

    return {
      totalSpaces: row.total_spaces,
      totalMemories: row.total_memories,
      queuedJobs: row.queued_jobs,
      runningJobs: row.running_jobs,
    };
  }
}
