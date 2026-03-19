import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENGINE_LOCK_FILE,
  ENGINE_STARTUP_LOCK_FILE,
  ENGINE_STDERR_LOG_FILE,
  MEMORY_DB_FILE,
  MEMORY_EVENTS_LOG_FILE,
} from './constants.js';

export interface GlobalPaths {
  memoriesDir: string;
  dbPath: string;
  lockPath: string;
  startupLockPath: string;
  engineStderrPath: string;
  eventLogPath: string;
}

export function resolveProjectRoot(explicitProjectRoot?: string): string {
  if (explicitProjectRoot && path.isAbsolute(explicitProjectRoot)) {
    return explicitProjectRoot;
  }

  const envProjectRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envProjectRoot && path.isAbsolute(envProjectRoot)) {
    return envProjectRoot;
  }

  return process.cwd();
}

export function resolvePluginRoot(): string {
  const envPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envPluginRoot && path.isAbsolute(envPluginRoot)) {
    return envPluginRoot;
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path.dirname(currentFilePath);
  return path.resolve(moduleDirectory, '..', '..');
}

export function getGlobalPaths(): GlobalPaths {
  const memoriesDir = path.join(os.homedir(), '.claude', 'memories');
  return {
    memoriesDir,
    dbPath: path.join(memoriesDir, MEMORY_DB_FILE),
    lockPath: path.join(memoriesDir, ENGINE_LOCK_FILE),
    startupLockPath: path.join(memoriesDir, ENGINE_STARTUP_LOCK_FILE),
    engineStderrPath: path.join(memoriesDir, ENGINE_STDERR_LOG_FILE),
    eventLogPath: path.join(memoriesDir, MEMORY_EVENTS_LOG_FILE),
  };
}

export async function ensureGlobalDirectories(): Promise<GlobalPaths> {
  const globalPaths = getGlobalPaths();
  await mkdir(globalPaths.memoriesDir, { recursive: true });
  return globalPaths;
}
