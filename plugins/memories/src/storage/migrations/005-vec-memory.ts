import { MEMORY_SEMANTIC_DIMENSIONS } from "../../shared/constants/embeddings.js";
import type { StorageMigration } from "../types/database.js";

export const vecMemoryMigration: StorageMigration = {
  version: 5,
  name: "vec-memory",
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${String(MEMORY_SEMANTIC_DIMENSIONS)}] distance_metric=cosine
    );
  `,
};
