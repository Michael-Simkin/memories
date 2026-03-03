import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENGINE_LOCK_FILE,
  HOOK_LOG_FILE,
  MEMORY_DB_FILE,
  OPERATION_LOG_FILE,
} from './constants.js';

export interface ProjectPaths {
  projectRoot: string;
  memoriesDir: string;
  dbPath: string;
  lockPath: string;
  operationLogPath: string;
  hookLogPath: string;
}

export function resolveProjectRoot(explicitProjectRoot?: string): string {
  if (explicitProjectRoot && path.isAbsolute(explicitProjectRoot)) {
    return explicitProjectRoot;
  }
  const envRoot = process.env.CLAUDE_PROJECT_DIR;
  if (envRoot && path.isAbsolute(envRoot)) {
    return envRoot;
  }
  return process.cwd();
}

export function resolvePluginRoot(): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && path.isAbsolute(pluginRoot)) {
    return pluginRoot;
  }
  const currentFilePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(currentFilePath);
  return path.resolve(moduleDir, '..', '..');
}

export function getProjectPaths(projectRoot: string): ProjectPaths {
  const memoriesDir = path.join(projectRoot, '.memories');
  return {
    projectRoot,
    memoriesDir,
    dbPath: path.join(memoriesDir, MEMORY_DB_FILE),
    hookLogPath: path.join(memoriesDir, HOOK_LOG_FILE),
    lockPath: path.join(memoriesDir, ENGINE_LOCK_FILE),
    operationLogPath: path.join(memoriesDir, OPERATION_LOG_FILE),
  };
}

export async function ensureProjectDirectories(projectRoot: string): Promise<ProjectPaths> {
  const projectPaths = getProjectPaths(projectRoot);
  await mkdir(projectPaths.memoriesDir, { recursive: true });
  return projectPaths;
}
