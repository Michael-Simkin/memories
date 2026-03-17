import type { DatabaseSync } from "node:sqlite";

import type { PluginPathResolutionInput } from "../../shared/types/plugin-paths.js";
import type { ResolveStoragePathsOptions } from "../../shared/types/storage.js";

export interface SqliteOpenOptions extends PluginPathResolutionInput {
  loadVectorExtension?: boolean | undefined;
}

export interface DatabaseBootstrapOptions
  extends ResolveStoragePathsOptions,
    SqliteOpenOptions {
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
