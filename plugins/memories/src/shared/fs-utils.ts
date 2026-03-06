import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteJson(filePath: string, payload: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await rm(filePath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function normalizePathForMatch(inputPath: string): string {
  const posixPath = inputPath.replaceAll('\\', '/').trim();
  if (!posixPath) {
    return '';
  }

  const normalized = path.posix.normalize(posixPath);
  if (normalized === '.') {
    return '';
  }
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
