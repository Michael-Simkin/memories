import { mkdir, open, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { engineLockSchema, engineStartupLockSchema } from "../schemas/engine.js";
import { StoragePathsService } from "./storage-paths-service.js";
class EngineLockService {
  static hasErrorCode(error, code) {
    return typeof error === "object" && error !== null && "code" in error && error["code"] === code;
  }
  static isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (EngineLockService.hasErrorCode(error, "ESRCH")) {
        return false;
      }
      if (EngineLockService.hasErrorCode(error, "EPERM")) {
        return true;
      }
      throw new Error(`Failed to determine whether pid "${String(pid)}" is alive.`, {
        cause: error
      });
    }
  }
  static async writeJsonFileAtomically(targetPath, value) {
    const targetDirectoryPath = path.dirname(targetPath);
    const tempPath = `${targetPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await mkdir(targetDirectoryPath, { recursive: true });
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}
`, "utf8");
      await rename(tempPath, targetPath);
    } finally {
      await rm(tempPath, { force: true });
    }
  }
  static async writeJsonFileExclusively(targetPath, value) {
    const targetDirectoryPath = path.dirname(targetPath);
    await mkdir(targetDirectoryPath, { recursive: true });
    try {
      const fileHandle = await open(targetPath, "wx");
      try {
        await fileHandle.writeFile(`${JSON.stringify(value, null, 2)}
`, "utf8");
      } finally {
        await fileHandle.close();
      }
      return true;
    } catch (error) {
      if (EngineLockService.hasErrorCode(error, "EEXIST")) {
        return false;
      }
      throw new Error(`Failed to write lock file at "${targetPath}".`, {
        cause: error
      });
    }
  }
  static async readLockFile(targetPath, label, parseValue) {
    let serializedValue;
    try {
      serializedValue = await readFile(targetPath, "utf8");
    } catch (error) {
      if (EngineLockService.hasErrorCode(error, "ENOENT")) {
        return null;
      }
      throw new Error(`Failed to read ${label} at "${targetPath}".`, {
        cause: error
      });
    }
    let parsedValue;
    try {
      parsedValue = JSON.parse(serializedValue);
    } catch (error) {
      throw new Error(`Failed to parse ${label} at "${targetPath}".`, {
        cause: error
      });
    }
    try {
      return parseValue(parsedValue);
    } catch (error) {
      throw new Error(`Invalid ${label} at "${targetPath}".`, {
        cause: error
      });
    }
  }
  static async clearLockIfOwned(expectedPid, targetPath, readLock) {
    const currentLock = await readLock();
    if (!currentLock || currentLock.pid !== expectedPid) {
      return false;
    }
    await rm(targetPath, { force: true });
    return true;
  }
  static async readLockIfProcessAlive(targetPath, readLock) {
    const currentLock = await readLock();
    if (!currentLock) {
      return null;
    }
    if (EngineLockService.isProcessAlive(currentLock.pid)) {
      return currentLock;
    }
    await rm(targetPath, { force: true });
    return null;
  }
  static async readEngineLock(options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    return EngineLockService.readLockFile(
      storagePaths.engineLockPath,
      "engine lock",
      (value) => engineLockSchema.parse(value)
    );
  }
  static async readEngineLockIfProcessAlive(options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    return EngineLockService.readLockIfProcessAlive(
      storagePaths.engineLockPath,
      () => EngineLockService.readEngineLock(options)
    );
  }
  static async writeEngineLock(input, options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    const engineLock = engineLockSchema.parse({
      ...input,
      storage_root: storagePaths.rootPath
    });
    await EngineLockService.writeJsonFileAtomically(
      storagePaths.engineLockPath,
      engineLock
    );
    return engineLock;
  }
  static async clearEngineLockIfOwned(expectedPid, options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    return EngineLockService.clearLockIfOwned(
      expectedPid,
      storagePaths.engineLockPath,
      () => EngineLockService.readEngineLock(options)
    );
  }
  static async readEngineStartupLock(options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    return EngineLockService.readLockFile(
      storagePaths.engineStartupLockPath,
      "engine startup lock",
      (value) => engineStartupLockSchema.parse(value)
    );
  }
  static async readEngineStartupLockIfProcessAlive(options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    return EngineLockService.readLockIfProcessAlive(
      storagePaths.engineStartupLockPath,
      () => EngineLockService.readEngineStartupLock(options)
    );
  }
  static async writeEngineStartupLock(input, options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    const engineStartupLock = engineStartupLockSchema.parse({
      ...input,
      storage_root: storagePaths.rootPath
    });
    await EngineLockService.writeJsonFileAtomically(
      storagePaths.engineStartupLockPath,
      engineStartupLock
    );
    return engineStartupLock;
  }
  static async acquireEngineStartupLock(input, options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    const engineStartupLock = engineStartupLockSchema.parse({
      ...input,
      storage_root: storagePaths.rootPath
    });
    const wasWritten = await EngineLockService.writeJsonFileExclusively(
      storagePaths.engineStartupLockPath,
      engineStartupLock
    );
    if (!wasWritten) {
      return null;
    }
    return engineStartupLock;
  }
  static async clearEngineStartupLockIfOwned(expectedPid, options = {}) {
    const storagePaths = StoragePathsService.resolveMemoryStoragePaths(options);
    return EngineLockService.clearLockIfOwned(
      expectedPid,
      storagePaths.engineStartupLockPath,
      () => EngineLockService.readEngineStartupLock(options)
    );
  }
}
export {
  EngineLockService
};
