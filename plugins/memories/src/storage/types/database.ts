import type { DatabaseSync } from "node:sqlite";

import type { ResolveStoragePathsOptions } from "../../shared/types/storage.js";

export interface DatabaseBootstrapOptions extends ResolveStoragePathsOptions {
  databasePath?: string | undefined;
}

export interface DatabaseBootstrapResult {
  database: DatabaseSync;
  databasePath: string;
  schemaVersion: number;
}

export interface StorageMigration {
  version: number;
  name: string;
  sql: string;
  isDestructive?: boolean | undefined;
}
