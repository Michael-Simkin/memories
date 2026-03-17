import { StoragePathsService } from "../../shared/services/storage-paths-service.js";
import { STORAGE_MIGRATIONS } from "../migrations/index.js";
import { SqliteService } from "../sqlite-service.js";
class DatabaseBootstrapRepository {
  static getLatestSchemaVersion() {
    return STORAGE_MIGRATIONS.at(-1)?.version ?? 0;
  }
  static getOrderedMigrations() {
    const orderedMigrations = [...STORAGE_MIGRATIONS].sort(
      (leftMigration, rightMigration) => leftMigration.version - rightMigration.version
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
  static applyMigration(database, migration) {
    if (migration.isDestructive) {
      throw new Error(
        `Destructive migration "${migration.name}" requires backup handling before execution.`
      );
    }
    SqliteService.transaction(database, () => {
      database.exec(migration.sql);
      SqliteService.writeUserVersion(database, migration.version);
    });
  }
  static migrateDatabase(database) {
    const currentSchemaVersion = SqliteService.readUserVersion(database);
    const orderedMigrations = DatabaseBootstrapRepository.getOrderedMigrations();
    const latestSchemaVersion = DatabaseBootstrapRepository.getLatestSchemaVersion();
    if (currentSchemaVersion > latestSchemaVersion) {
      throw new Error(
        `Database schema version ${String(currentSchemaVersion)} is newer than supported version ${String(latestSchemaVersion)}.`
      );
    }
    let appliedSchemaVersion = currentSchemaVersion;
    for (const migration of orderedMigrations) {
      if (migration.version <= appliedSchemaVersion) {
        continue;
      }
      DatabaseBootstrapRepository.applyMigration(database, migration);
      appliedSchemaVersion = migration.version;
    }
    return appliedSchemaVersion;
  }
  static bootstrapDatabase(options = {}) {
    const loadVectorExtension = options.loadVectorExtension ?? true;
    const databasePath = options.databasePath ?? StoragePathsService.resolveMemoryStoragePaths(options).databasePath;
    const database = SqliteService.openDatabase(databasePath, {
      ...options,
      loadVectorExtension
    });
    try {
      const schemaVersion = DatabaseBootstrapRepository.migrateDatabase(database);
      return {
        database,
        databasePath,
        schemaVersion
      };
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
export {
  DatabaseBootstrapRepository
};
