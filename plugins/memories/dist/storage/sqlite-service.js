import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSupportService } from "../shared/services/runtime-support-service.js";
import { loadSqliteVecExtension } from "./sqlite-vec-service.js";
class SqliteService {
  static configureDatabase(database, databasePath) {
    database.exec("PRAGMA foreign_keys = ON;");
    if (databasePath !== ":memory:") {
      database.exec("PRAGMA journal_mode = WAL;");
    }
  }
  static ensureDatabaseParentDirectory(databasePath) {
    if (databasePath === ":memory:") {
      return;
    }
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  static openDatabase(databasePath, options = {}) {
    RuntimeSupportService.assertSupportedRuntime();
    SqliteService.ensureDatabaseParentDirectory(databasePath);
    const database = new DatabaseSync(databasePath, {
      allowExtension: options.loadVectorExtension === true
    });
    try {
      SqliteService.configureDatabase(database, databasePath);
      if (options.loadVectorExtension) {
        loadSqliteVecExtension(database, {
          pluginRoot: options.pluginRoot
        });
      }
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  static readUserVersion(database) {
    const row = database.prepare("PRAGMA user_version;").get();
    return row.user_version;
  }
  static writeUserVersion(database, userVersion) {
    database.exec(`PRAGMA user_version = ${String(userVersion)};`);
  }
  static transaction(database, operation) {
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
export {
  SqliteService
};
