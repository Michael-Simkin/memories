import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { logDebug } from '../shared/logger.js';

export interface TranscriptFile {
  path: string;
  mtime: number;
}

export function scanTranscripts(claudeProjectsDir: string): TranscriptFile[] {
  const results: TranscriptFile[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(claudeProjectsDir, entry.name));
  } catch {
    logDebug('Could not read Claude projects directory', { path: claudeProjectsDir });
    return results;
  }

  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = readdirSync(projectDir)
        .filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = path.join(projectDir, file);
      try {
        const stat = statSync(fullPath);
        results.push({ path: fullPath, mtime: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }

  logDebug('Scan complete', { transcriptCount: results.length });
  return results;
}
