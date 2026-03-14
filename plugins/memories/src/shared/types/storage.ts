export interface ResolveStoragePathsOptions {
  claudeMemoryHome?: string | undefined;
  currentWorkingDirectory?: string | undefined;
  userHomeDirectory?: string | undefined;
}

export interface MemoryStoragePaths {
  rootPath: string;
  databasePath: string;
  engineLockPath: string;
  engineStartupLockPath: string;
  engineStderrLogPath: string;
  tmpDirectoryPath: string;
}
