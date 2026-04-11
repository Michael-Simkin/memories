import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REQUIRED_NODE_MAJOR = 24;
const NODE_PROBE_TIMEOUT_MS = 1_500;

interface NodeRuntime {
  executable: string;
  version: string;
  major: number;
}

export async function resolveNode24Runtime(): Promise<NodeRuntime> {
  const discovered: NodeRuntime[] = [];

  for (const executable of candidateNodeExecutables()) {
    const version = await probeNodeVersion(executable);
    if (!version) continue;

    const major = parseNodeMajor(version);
    if (!Number.isFinite(major) || major < REQUIRED_NODE_MAJOR) continue;

    discovered.push({ executable, version, major });
    if (major === REQUIRED_NODE_MAJOR) break;
  }

  const preferred =
    discovered.find((d) => d.major === REQUIRED_NODE_MAJOR) ??
    discovered.sort((a, b) => a.major - b.major)[0];

  if (preferred) {
    return preferred;
  }

  throw new Error(
    `Node ${REQUIRED_NODE_MAJOR}.x+ is required. Install with \`nvm install ${REQUIRED_NODE_MAJOR}\` ` +
      `or set TRANSCRIPTS_NODE_BIN to an absolute Node ${REQUIRED_NODE_MAJOR}+ binary path.`,
  );
}

function parseNodeMajor(version: string): number {
  const majorText = version.trim().replace(/^v/i, '').split('.')[0] ?? '';
  return Number.parseInt(majorText, 10);
}

function candidateNodeExecutables(): string[] {
  const homeDirectory = os.homedir();
  const nvmDirectory = process.env.NVM_DIR || path.join(homeDirectory, '.nvm');

  const candidates = [
    process.env.TRANSCRIPTS_NODE_BIN ?? '',
    '/opt/homebrew/opt/node@24/bin/node',
    '/usr/local/opt/node@24/bin/node',
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : '',
    ...listVersionedNodeBins(path.join(nvmDirectory, 'versions', 'node')),
    ...listVersionedNodeBins(path.join(homeDirectory, '.asdf', 'installs', 'nodejs')),
    ...listVersionedNodeBins(path.join(homeDirectory, '.volta', 'tools', 'image', 'node')),
    process.execPath,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ];

  const seen = new Set<string>();
  return candidates
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => path.resolve(c))
    .filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
}

function listVersionedNodeBins(rootDirectory: string): string[] {
  if (!existsSync(rootDirectory)) return [];
  return readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a))
    .map((version) => path.join(rootDirectory, version, 'bin', 'node'));
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/i, '').split('.').map(Number);
  const rightParts = right.replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function probeNodeVersion(executable: string): Promise<string | null> {
  if (!existsSync(executable)) return null;
  try {
    const { stdout } = await execFileAsync(executable, ['-p', 'process.versions.node'], {
      timeout: NODE_PROBE_TIMEOUT_MS,
    });
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}
