import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveRepoId } from '../shared/repo-identity.js';
import type { DiscoveredTranscript, DiscoveryResult } from './types.js';

const MIN_LINE_COUNT = 3;

export async function discoverTranscripts(): Promise<DiscoveryResult> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  let projectFolders: string[];
  try {
    projectFolders = await readdir(claudeDir);
  } catch {
    return { transcripts: [], projects: new Map() };
  }

  const transcripts: DiscoveredTranscript[] = [];

  for (const folder of projectFolders) {
    const folderPath = path.join(claudeDir, folder);
    const folderStat = await stat(folderPath).catch(() => null);
    if (!folderStat?.isDirectory()) {
      continue;
    }

    const entries = await readdir(folderPath).catch(() => []);
    const jsonlFiles = entries.filter((e) => e.endsWith('.jsonl'));

    for (const file of jsonlFiles) {
      const transcriptPath = path.join(folderPath, file);
      const transcript = await probeTranscript(transcriptPath, folder, file);
      if (transcript) {
        transcripts.push(transcript);
      }
    }
  }

  const projects = new Map<string, DiscoveredTranscript[]>();
  for (const t of transcripts) {
    const list = projects.get(t.repoId) ?? [];
    list.push(t);
    projects.set(t.repoId, list);
  }
  for (const list of projects.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  return { transcripts, projects };
}

async function probeTranscript(
  transcriptPath: string,
  projectFolder: string,
  fileName: string,
): Promise<DiscoveredTranscript | null> {
  try {
    const raw = await readFile(transcriptPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length < MIN_LINE_COUNT) {
      return null;
    }

    const firstLine = parseFirstEntry(lines);
    if (!firstLine?.cwd || !path.isAbsolute(firstLine.cwd)) {
      return null;
    }

    const cwd = firstLine.cwd;
    let repoId: string;
    try {
      repoId = await resolveRepoId(cwd);
    } catch {
      return null;
    }

    return {
      transcriptPath,
      projectFolder,
      cwd,
      repoId,
      sessionId: firstLine.sessionId ?? path.basename(fileName, '.jsonl'),
      timestamp: firstLine.timestamp ?? '',
      lineCount: lines.length,
    };
  } catch {
    return null;
  }
}

function parseFirstEntry(lines: string[]): {
  cwd: string;
  sessionId?: string | undefined;
  timestamp?: string | undefined;
} | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.cwd === 'string') {
        return {
          cwd: obj.cwd,
          sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
          timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}
