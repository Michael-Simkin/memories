import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RuntimeSupportService } from "../shared/services/runtime-support-service.js";
import { loadSqliteVecExtension } from "./sqlite-vec-service.js";
import type { SqliteOpenOptions } from "./types/database.js";

export class SqliteService {
  private static configureDatabase(database: DatabaseSync, databasePath: string): void {
    database.exec("PRAGMA foreign_keys = ON;");

    if (databasePath !== ":memory:") {
      database.exec("PRAGMA journal_mode = WAL;");
    }
  }

  private static ensureDatabaseParentDirectory(databasePath: string): void {
    if (databasePath === ":memory:") {
      return;
    }

    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  static openDatabase(
    databasePath: string,
    options: SqliteOpenOptions = {},
  ): DatabaseSync {
    RuntimeSupportService.assertSupportedRuntime();
    SqliteService.ensureDatabaseParentDirectory(databasePath);

    const database = new DatabaseSync(databasePath, {
      allowExtension: options.loadVectorExtension === true,
    });

    try {
      SqliteService.configureDatabase(database, databasePath);

      if (options.loadVectorExtension) {
        loadSqliteVecExtension(database, {
          pluginRoot: options.pluginRoot,
        });
      }

      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static readUserVersion(database: DatabaseSync): number {
    const row = database.prepare("PRAGMA user_version;").get() as {
      user_version: number;
    };

    return row.user_version;
  }

  static writeUserVersion(database: DatabaseSync, userVersion: number): void {
    database.exec(`PRAGMA user_version = ${String(userVersion)};`);
  }

  static transaction<T>(database: DatabaseSync, operation: () => T): T {
    database.exec("BEGIN;");

    try {
      const result = operation();
      database.exec("COMMIT;");
      return result;
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
}
