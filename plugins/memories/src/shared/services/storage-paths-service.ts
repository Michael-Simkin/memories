import { homedir } from "node:os";
import path from "node:path";

import type {
  MemoryStoragePaths,
  ResolveStoragePathsOptions,
} from "../types/storage.js";
import { normalizeNonEmptyString } from "../utils/strings.js";

export class StoragePathsService {
  private static readonly DEFAULT_STORAGE_ROOT_SEGMENTS = [
    ".claude",
    "memories",
  ] as const;

  static resolveMemoryStorageRoot(options: ResolveStoragePathsOptions = {}): string {
    const currentWorkingDirectory = options.currentWorkingDirectory ?? process.cwd();
    const userHomeDirectory = options.userHomeDirectory ?? homedir();
    const configuredHome = normalizeNonEmptyString(
      options.claudeMemoryHome ?? process.env["CLAUDE_MEMORY_HOME"]
    );

    if (configuredHome) {
      return path.resolve(currentWorkingDirectory, configuredHome);
    }

    return path.join(
      userHomeDirectory,
      ...StoragePathsService.DEFAULT_STORAGE_ROOT_SEGMENTS,
    );
  }

  static resolveMemoryStoragePaths(
    options: ResolveStoragePathsOptions = {},
  ): MemoryStoragePaths {
    const rootPath = StoragePathsService.resolveMemoryStorageRoot(options);

    return {
      rootPath,
      databasePath: path.join(rootPath, "memory.db"),
      engineLockPath: path.join(rootPath, "engine.lock.json"),
      engineStartupLockPath: path.join(rootPath, "engine.startup.lock.json"),
      engineStderrLogPath: path.join(rootPath, "engine.stderr.log"),
      tmpDirectoryPath: path.join(rootPath, "tmp"),
    };
  }
}
