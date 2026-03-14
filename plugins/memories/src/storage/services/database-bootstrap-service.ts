import { StoragePathsService } from "../../shared/services/storage-paths-service.js";
import { STORAGE_MIGRATIONS } from "../migrations/index.js";
import { SqliteService } from "./sqlite-service.js";
import type {
  DatabaseBootstrapOptions,
  DatabaseBootstrapResult,
  StorageMigration,
} from "../types/database.js";
import type { DatabaseSync } from "node:sqlite";

export class DatabaseBootstrapService {
  private static getLatestSchemaVersion(): number {
    return STORAGE_MIGRATIONS.at(-1)?.version ?? 0;
  }

  private static getOrderedMigrations(): StorageMigration[] {
    const orderedMigrations = [...STORAGE_MIGRATIONS].sort(
      (leftMigration, rightMigration) => leftMigration.version - rightMigration.version,
    );

    for (const [index, currentMigration] of orderedMigrations.entries()) {
      if (index === 0) {
        continue;
      }

      const previousMigration = orderedMigrations[index - 1];

      if (previousMigration && currentMigration.version <= previousMigration.version) {
        throw new Error("Storage migrations must use strictly increasing versions.");
      }
    }

    return orderedMigrations;
  }

  private static applyMigration(database: DatabaseSync, migration: StorageMigration): void {
    if (migration.isDestructive) {
      throw new Error(
        `Destructive migration "${migration.name}" requires backup handling before execution.`,
      );
    }

    SqliteService.transaction(database, () => {
      database.exec(migration.sql);
      SqliteService.writeUserVersion(database, migration.version);
    });
  }

  private static migrateDatabase(database: DatabaseSync): number {
    const currentSchemaVersion = SqliteService.readUserVersion(database);
    const orderedMigrations = DatabaseBootstrapService.getOrderedMigrations();
    const latestSchemaVersion = DatabaseBootstrapService.getLatestSchemaVersion();

    if (currentSchemaVersion > latestSchemaVersion) {
      throw new Error(
        `Database schema version ${String(currentSchemaVersion)} is newer than supported version ${String(latestSchemaVersion)}.`,
      );
    }

    let appliedSchemaVersion = currentSchemaVersion;

    for (const migration of orderedMigrations) {
      if (migration.version <= appliedSchemaVersion) {
        continue;
      }

      DatabaseBootstrapService.applyMigration(database, migration);
      appliedSchemaVersion = migration.version;
    }

    return appliedSchemaVersion;
  }

  static bootstrapDatabase(
    options: DatabaseBootstrapOptions = {},
  ): DatabaseBootstrapResult {
    const databasePath =
      options.databasePath ??
      StoragePathsService.resolveMemoryStoragePaths(options).databasePath;
    const database = SqliteService.openDatabase(databasePath);

    try {
      const schemaVersion = DatabaseBootstrapService.migrateDatabase(database);

      return {
        database,
        databasePath,
        schemaVersion,
      };
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
