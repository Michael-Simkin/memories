import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REQUIRED_ENGINE_NODE_MAJOR = 24;
const NODE_PROBE_TIMEOUT_MS = 1_500;

export interface NodeRuntimeCandidate {
  executable: string;
  version: string;
}

export interface NodeRuntimeDescriptor extends NodeRuntimeCandidate {
  major: number;
}

export interface NpmInvocation {
  argsPrefix: string[];
  command: string;
}

export function parseNodeMajor(version: string): number {
  const majorText = version.trim().replace(/^v/i, '').split('.')[0] ?? '';
  const major = Number.parseInt(majorText, 10);
  return Number.isFinite(major) ? major : Number.NaN;
}

export function selectPreferredNodeRuntime(
  candidates: NodeRuntimeCandidate[],
): NodeRuntimeDescriptor | null {
  let preferred: NodeRuntimeDescriptor | null = null;
  let fallback: NodeRuntimeDescriptor | null = null;

  for (const candidate of candidates) {
    const major = parseNodeMajor(candidate.version);
    if (!Number.isFinite(major)) {
      continue;
    }

    const descriptor: NodeRuntimeDescriptor = {
      ...candidate,
      major,
    };

    if (major === REQUIRED_ENGINE_NODE_MAJOR) {
      if (!preferred || compareNodeVersions(descriptor.version, preferred.version) > 0) {
        preferred = descriptor;
      }
      continue;
    }

    if (major > REQUIRED_ENGINE_NODE_MAJOR) {
      if (!fallback || compareNodeVersions(descriptor.version, fallback.version) > 0) {
        fallback = descriptor;
      }
    }
  }

  return preferred ?? fallback;
}

export async function resolveEngineNodeRuntime(): Promise<NodeRuntimeDescriptor> {
  const discovered: NodeRuntimeDescriptor[] = [];

  for (const executable of candidateNodeExecutables()) {
    const version = await probeNodeVersion(executable);
    if (!version) {
      continue;
    }

    const major = parseNodeMajor(version);
    if (!Number.isFinite(major)) {
      continue;
    }

    discovered.push({
      executable,
      version,
      major,
    });
  }

  const preferred = selectPreferredNodeRuntime(discovered);
  if (preferred) {
    return preferred;
  }

  const highestFound = [...discovered].sort((left, right) =>
    compareNodeVersions(right.version, left.version),
  )[0];
  const highestDetail = highestFound
    ? `highest discovered runtime is v${highestFound.version} at ${highestFound.executable}`
    : 'no candidate node runtime was discovered';

  throw new Error(
    `Node ${REQUIRED_ENGINE_NODE_MAJOR}.x is required for engine startup (${highestDetail}). ` +
      `Install it with \`nvm install ${REQUIRED_ENGINE_NODE_MAJOR}\` or set MEMORIES_NODE_BIN to an absolute Node ${REQUIRED_ENGINE_NODE_MAJOR} binary path.`,
  );
}

export function resolveNpmInvocation(nodeExecutable: string): NpmInvocation {
  const nodeDirectory = path.dirname(nodeExecutable);
  for (const npmCliPath of candidateNpmCliPaths(nodeDirectory)) {
    if (existsSync(npmCliPath)) {
      return {
        argsPrefix: [npmCliPath],
        command: nodeExecutable,
      };
    }
  }

  throw new Error(
    `npm was not found alongside ${nodeExecutable}. Install a full Node ${REQUIRED_ENGINE_NODE_MAJOR}+ distribution or set MEMORIES_NODE_BIN to a Node binary bundled with npm.`,
  );
}

function candidateNpmCliPaths(nodeDirectory: string): string[] {
  if (process.platform === 'win32') {
    return [
      path.resolve(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(nodeDirectory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
  }

  return [
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

function compareNodeVersions(left: string, right: string): number {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function normalizeVersionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function dedupeCandidates(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) {
      continue;
    }

    const resolvedValue = path.resolve(value);
    if (seen.has(resolvedValue)) {
      continue;
    }

    seen.add(resolvedValue);
    ordered.push(resolvedValue);
  }

  return ordered;
}

function listVersionedNodeBins(rootDirectory: string): string[] {
  if (!existsSync(rootDirectory)) {
    return [];
  }

  const versions = readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => compareNodeVersions(right, left));

  return versions.map((version) => path.join(rootDirectory, version, 'bin', 'node'));
}

function candidateNodeExecutables(): string[] {
  const homeDirectory = os.homedir();
  const nvmDirectory = process.env.NVM_DIR || path.join(homeDirectory, '.nvm');

  return dedupeCandidates([
    process.env.MEMORIES_NODE_BIN ?? '',
    '/opt/homebrew/opt/node@24/bin/node',
    '/usr/local/opt/node@24/bin/node',
    process.env.NVM_BIN ? path.join(process.env.NVM_BIN, 'node') : '',
    ...listVersionedNodeBins(path.join(nvmDirectory, 'versions', 'node')),
    ...listVersionedNodeBins(path.join(homeDirectory, '.asdf', 'installs', 'nodejs')),
    ...listVersionedNodeBins(path.join(homeDirectory, '.volta', 'tools', 'image', 'node')),
    process.execPath,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ]);
}

async function probeNodeVersion(executable: string): Promise<string | null> {
  if (!existsSync(executable)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(executable, ['-p', 'process.versions.node'], {
      timeout: NODE_PROBE_TIMEOUT_MS,
    });
    const version = String(stdout).trim();
    return version || null;
  } catch {
    return null;
  }
}
