import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";

import { engineLockSchema, engineStartupLockSchema } from "../schemas/engine.js";
import { StoragePathsService } from "./storage-paths-service.js";
import type {
  EngineLock,
  EngineStartupLock,
  WriteEngineLockInput,
  WriteEngineStartupLockInput,
} from "../types/engine.js";
import type { ResolveStoragePathsOptions } from "../types/storage.js";

export class EngineLockService {
  private static hasErrorCode(error: unknown, code: string): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error["code"] === code
    );
  }

  private static async writeJsonFileAtomically(
    targetPath: string,
    value: unknown,
  ): Promise<void> {
    const targetDirectoryPath = path.dirname(targetPath);
    const tempPath = `${targetPath}.${String(process.pid)}.${String(Date.now())}.tmp`;

    await mkdir(targetDirectoryPath, { recursive: true });

    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(tempPath, targetPath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private static async readLockFile<T>(
    targetPath: string,
    label: string,
    parseValue: (value: unknown) => T,
  ): Promise<T | null> {
    let serializedValue: string;

    try {
      serializedValue = await readFile(targetPath, "utf8");
    } catch (error) {
      if (EngineLockService.hasErrorCode(error, "ENOENT")) {
        return null;
      }

      throw new Error(`Failed to read ${label} at "${targetPath}".`, {
        cause: error,
      });
    }

    let parsedValue: unknown;

    try {
      parsedValue = JSON.parse(serializedValue);
    } catch (error) {
      throw new Error(`Failed to parse ${label} at "${targetPath}".`, {
        cause: error,
      });
    }

    try {
      return parseValue(parsedValue);
    } catch (error) {
      throw new Error(`Invalid ${label} at "${targetPath}".`, {
        cause: error,
      });
    }
  }

  private static async clearLockIfOwned<T extends { pid: number }>(
    expectedPid: number,
    targetPath: string,
    readLock: () => Promise<T | null>,
  ): Promise<boolean> {
    const currentLock = await readLock();

    if (!currentLock || currentLock.pid !== expectedPid) {
      return false;
    }

    await rm(targetPath, { force: true });

    return true;
  }

  static async readEngineLock(
    options: ResolveStoragePathsOptions = {},
  ): Promise<EngineLock | null> {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);

    return EngineLockService.readLockFile(
      storagePaths.engineLockPath,
      "engine lock",
      (value) => engineLockSchema.parse(value),
    );
  }

  static async writeEngineLock(
    input: WriteEngineLockInput,
    options: ResolveStoragePathsOptions = {},
  ): Promise<EngineLock> {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    const engineLock = engineLockSchema.parse({
      ...input,
      storage_root: storagePaths.rootPath,
    });

    await EngineLockService.writeJsonFileAtomically(
      storagePaths.engineLockPath,
      engineLock,
    );

    return engineLock;
  }

  static async clearEngineLockIfOwned(
    expectedPid: number,
    options: ResolveStoragePathsOptions = {},
  ): Promise<boolean> {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);

    return EngineLockService.clearLockIfOwned(
      expectedPid,
      storagePaths.engineLockPath,
      () => EngineLockService.readEngineLock(options),
    );
  }

  static async readEngineStartupLock(
    options: ResolveStoragePathsOptions = {},
  ): Promise<EngineStartupLock | null> {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);

    return EngineLockService.readLockFile(
      storagePaths.engineStartupLockPath,
      "engine startup lock",
      (value) => engineStartupLockSchema.parse(value),
    );
  }

  static async writeEngineStartupLock(
    input: WriteEngineStartupLockInput,
    options: ResolveStoragePathsOptions = {},
  ): Promise<EngineStartupLock> {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    const engineStartupLock = engineStartupLockSchema.parse({
      ...input,
      storage_root: storagePaths.rootPath,
    });

    await EngineLockService.writeJsonFileAtomically(
      storagePaths.engineStartupLockPath,
      engineStartupLock,
    );

    return engineStartupLock;
  }

  static async clearEngineStartupLockIfOwned(
    expectedPid: number,
    options: ResolveStoragePathsOptions = {},
  ): Promise<boolean> {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);

    return EngineLockService.clearLockIfOwned(
      expectedPid,
      storagePaths.engineStartupLockPath,
      () => EngineLockService.readEngineStartupLock(options),
    );
  }
}
