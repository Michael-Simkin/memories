import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function createDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

export async function createDirectorySymlink(
  targetPath: string,
  linkPath: string,
): Promise<void> {
  await symlink(targetPath, linkPath);
}

export async function removePath(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

export async function runGitCommand(
  workingDirectory: string,
  args: string[],
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: workingDirectory,
    encoding: "utf8",
  });

  return result.stdout.trim();
}

export async function initializeGitRepository(repositoryPath: string): Promise<void> {
  await createDirectory(repositoryPath);
  await runGitCommand(repositoryPath, ["init", "-q"]);
}
