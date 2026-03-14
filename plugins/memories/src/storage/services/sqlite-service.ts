import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RuntimeSupportService } from "../../shared/services/runtime-support-service.js";

export class SqliteService {
  private static ensureDatabaseParentDirectory(databasePath: string): void {
    if (databasePath === ":memory:") {
      return;
    }

    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  static openDatabase(databasePath: string): DatabaseSync {
    RuntimeSupportService.assertSupportedRuntime();
    SqliteService.ensureDatabaseParentDirectory(databasePath);

    return new DatabaseSync(databasePath);
  }
}
