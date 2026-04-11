import { readFile, rename, rm, writeFile } from 'node:fs/promises';

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

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
