import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { normalizeNonEmptyString } from "../utils/strings.js";
const execFileAsync = promisify(execFile);
class GitInspectionService {
  static async runGitCommand(workingDirectory, args) {
    try {
      const result = await execFileAsync("git", args, {
        cwd: workingDirectory,
        encoding: "utf8"
      });
      return {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr
      };
    } catch (error) {
      const failure = error;
      if (failure.code === "ENOENT" && failure.stdout === void 0 && failure.stderr === void 0) {
        throw new Error("Unable to execute git while inspecting the working context.", {
          cause: error
        });
      }
      return {
        ok: false,
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" ? failure.stderr : ""
      };
    }
  }
  static async inspectGitContext(resolvedWorkingPath) {
    const insideWorkTreeResult = await GitInspectionService.runGitCommand(
      resolvedWorkingPath,
      ["rev-parse", "--is-inside-work-tree"]
    );
    if (!insideWorkTreeResult.ok) {
      return {
        insideWorkTree: false
      };
    }
    const insideWorkTree = normalizeNonEmptyString(insideWorkTreeResult.stdout) === "true";
    if (!insideWorkTree) {
      return {
        insideWorkTree: false
      };
    }
    const gitTopLevelResult = await GitInspectionService.runGitCommand(
      resolvedWorkingPath,
      ["rev-parse", "--show-toplevel"]
    );
    if (!gitTopLevelResult.ok) {
      throw new Error("Unable to resolve the Git top-level directory.");
    }
    const gitTopLevelPathOutput = normalizeNonEmptyString(gitTopLevelResult.stdout);
    if (!gitTopLevelPathOutput) {
      throw new Error("Git did not return a top-level directory.");
    }
    const gitTopLevelPath = await realpath(gitTopLevelPathOutput);
    const originUrlResult = await GitInspectionService.runGitCommand(gitTopLevelPath, [
      "remote",
      "get-url",
      "origin"
    ]);
    return {
      insideWorkTree: true,
      gitTopLevelPath,
      originUrl: originUrlResult.ok ? normalizeNonEmptyString(originUrlResult.stdout) ?? null : null
    };
  }
}
export {
  GitInspectionService
};
