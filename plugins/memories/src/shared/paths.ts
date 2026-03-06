import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_LOCK_FILE, MEMORY_DB_FILE, MEMORY_EVENTS_LOG_FILE } from './constants.js';

export interface ProjectPaths {
  projectRoot: string;
  memoriesDir: string;
  dbPath: string;
  lockPath: string;
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

export function getProjectPaths(projectRoot: string): ProjectPaths {
  const memoriesDir = path.join(projectRoot, '.memories');
  return {
    projectRoot,
    memoriesDir,
    dbPath: path.join(memoriesDir, MEMORY_DB_FILE),
    lockPath: path.join(memoriesDir, ENGINE_LOCK_FILE),
    eventLogPath: path.join(memoriesDir, MEMORY_EVENTS_LOG_FILE),
  };
}

export async function ensureProjectDirectories(projectRoot: string): Promise<ProjectPaths> {
  const projectPaths = getProjectPaths(projectRoot);
  await mkdir(projectPaths.memoriesDir, { recursive: true });
  return projectPaths;
}
