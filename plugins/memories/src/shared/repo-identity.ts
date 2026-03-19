import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 3_000;

const repoIdCache = new Map<string, string>();
const repoLabelCache = new Map<string, string>();

function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function normalizeRemoteUrl(url: string): string {
  let normalized = url.trim();

  normalized = normalized.replace(/\.git\/?$/, '');
  normalized = normalized.replace(/\/+$/, '');

  const sshMatch = normalized.match(/^[\w.-]+@([\w.-]+):(.*)/);
  if (sshMatch) {
    const host = sshMatch[1]!.toLowerCase();
    const path = sshMatch[2]!;
    return `${host}/${path}`;
  }

  const httpsMatch = normalized.match(/^https?:\/\/([\w.-]+(?::\d+)?)\/(.*)/);
  if (httpsMatch) {
    const host = httpsMatch[1]!.toLowerCase();
    const path = httpsMatch[2]!;
    return `${host}/${path}`;
  }

  const sshProtoMatch = normalized.match(/^ssh:\/\/[\w.-]+@([\w.-]+(?::\d+)?)\/(.*)/);
  if (sshProtoMatch) {
    const host = sshProtoMatch[1]!.toLowerCase();
    const path = sshProtoMatch[2]!;
    return `${host}/${path}`;
  }

  return normalized;
}

async function gitExec(projectRoot: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, ...args], {
      timeout: GIT_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function resolveIdentity(projectRoot: string): Promise<{ id: string; label: string }> {
  const originUrl = await gitExec(projectRoot, ['remote', 'get-url', 'origin']);
  if (originUrl) {
    const normalized = normalizeRemoteUrl(originUrl);
    return { id: hashIdentity(normalized), label: normalized };
  }

  const toplevel = await gitExec(projectRoot, ['rev-parse', '--show-toplevel']);
  if (toplevel) {
    let resolved: string;
    try {
      resolved = await realpath(toplevel);
    } catch {
      resolved = toplevel;
    }
    return { id: hashIdentity(resolved), label: resolved };
  }

  let resolved: string;
  try {
    resolved = await realpath(projectRoot);
  } catch {
    resolved = projectRoot;
  }
  return { id: hashIdentity(resolved), label: resolved };
}

export async function resolveRepoId(projectRoot: string): Promise<string> {
  const cached = repoIdCache.get(projectRoot);
  if (cached) {
    return cached;
  }

  const { id, label } = await resolveIdentity(projectRoot);
  repoIdCache.set(projectRoot, id);
  repoLabelCache.set(projectRoot, label);
  return id;
}

export async function resolveRepoLabel(projectRoot: string): Promise<string> {
  const cached = repoLabelCache.get(projectRoot);
  if (cached) {
    return cached;
  }

  const { id, label } = await resolveIdentity(projectRoot);
  repoIdCache.set(projectRoot, id);
  repoLabelCache.set(projectRoot, label);
  return label;
}
