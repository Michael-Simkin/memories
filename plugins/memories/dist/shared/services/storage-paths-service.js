import { homedir } from "node:os";
import path from "node:path";
import { normalizeNonEmptyString } from "../utils/strings.js";
class StoragePathsService {
  static DEFAULT_STORAGE_ROOT_SEGMENTS = [
    ".claude",
    "memories"
  ];
  static resolveMemoryStorageRoot(options = {}) {
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
      ...StoragePathsService.DEFAULT_STORAGE_ROOT_SEGMENTS
    );
  }
  static resolveMemoryStoragePaths(options = {}) {
    const rootPath = StoragePathsService.resolveMemoryStorageRoot(options);
    return {
      rootPath,
      databasePath: path.join(rootPath, "memory.db"),
      engineLockPath: path.join(rootPath, "engine.lock.json"),
      engineStartupLockPath: path.join(rootPath, "engine.startup.lock.json"),
      engineStderrLogPath: path.join(rootPath, "engine.stderr.log"),
      tmpDirectoryPath: path.join(rootPath, "tmp")
    };
  }
}
export {
  StoragePathsService
};
