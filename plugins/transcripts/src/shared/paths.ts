import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYNC_LOCK_FILE, SYNC_STDERR_LOG_FILE, TRANSCRIPT_DB_FILE } from './constants.js';

export interface GlobalPaths {
  transcriptsDir: string;
  dbPath: string;
  syncLockPath: string;
  syncStderrPath: string;
  claudeProjectsDir: string;
}

export function resolvePluginRoot(): string {
  const envPluginRoot =
    process.env.PLUGIN_ROOT ?? process.env.CODEX_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
  if (envPluginRoot && path.isAbsolute(envPluginRoot)) {
    return envPluginRoot;
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path.dirname(currentFilePath);
  return path.resolve(moduleDirectory, '..', '..');
}

export function getGlobalPaths(): GlobalPaths {
  const transcriptsDir = path.join(os.homedir(), '.claude', 'transcripts');
  return {
    transcriptsDir,
    dbPath: path.join(transcriptsDir, TRANSCRIPT_DB_FILE),
    syncLockPath: path.join(transcriptsDir, SYNC_LOCK_FILE),
    syncStderrPath: path.join(transcriptsDir, SYNC_STDERR_LOG_FILE),
    claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'),
  };
}

export async function ensureGlobalDirectories(): Promise<GlobalPaths> {
  const globalPaths = getGlobalPaths();
  await mkdir(globalPaths.transcriptsDir, { recursive: true });
  return globalPaths;
}
