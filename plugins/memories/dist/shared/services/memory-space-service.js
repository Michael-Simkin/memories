import { createHash } from "node:crypto";
import { OriginNormalizationService } from "./origin-normalization-service.js";
import { normalizeNonEmptyString } from "../utils/strings.js";
class MemorySpaceService {
  static createSpaceKey(prefix, discriminator) {
    return createHash("sha256").update(`${prefix}:${discriminator}`, "utf8").digest("hex");
  }
  static createDirectorySpace(rootPath) {
    return {
      spaceKind: "directory",
      spaceKey: MemorySpaceService.createSpaceKey("dir", rootPath),
      displayName: rootPath,
      rootPath,
      rootKind: "directory_root",
      originUrl: null,
      originUrlNormalized: null
    };
  }
  static requireResolvedPath(value, label) {
    const normalizedValue = normalizeNonEmptyString(value);
    if (!normalizedValue) {
      throw new Error(`${label} must be a non-empty path.`);
    }
    return normalizedValue;
  }
  static requireGitTopLevelPath(git) {
    return MemorySpaceService.requireResolvedPath(git.gitTopLevelPath, "gitTopLevelPath");
  }
  static selectWorkingPath(input) {
    const orderedSources = [
      ["project_root", normalizeNonEmptyString(input.projectRoot)],
      ["cwd", normalizeNonEmptyString(input.cwd)],
      ["claude_project_dir", normalizeNonEmptyString(input.claudeProjectDir)],
      ["process_cwd", normalizeNonEmptyString(input.processCwd ?? process.cwd())]
    ];
    const selectedSource = orderedSources.find(([, value]) => value !== void 0);
    if (!selectedSource?.[1]) {
      throw new Error("Unable to resolve a working path.");
    }
    return {
      source: selectedSource[0],
      workingPath: selectedSource[1]
    };
  }
  static resolveMemorySpace(input) {
    const resolvedWorkingPath = MemorySpaceService.requireResolvedPath(
      input.resolvedWorkingPath,
      "resolvedWorkingPath"
    );
    if (!input.git.insideWorkTree) {
      return MemorySpaceService.createDirectorySpace(resolvedWorkingPath);
    }
    const gitTopLevelPath = MemorySpaceService.requireGitTopLevelPath(input.git);
    const originUrl = normalizeNonEmptyString(input.git.originUrl);
    const originUrlNormalized = originUrl ? OriginNormalizationService.normalizeOriginUrl(originUrl) : null;
    if (originUrl && originUrlNormalized) {
      return {
        spaceKind: "remote_repo",
        spaceKey: MemorySpaceService.createSpaceKey("remote", originUrlNormalized),
        displayName: originUrlNormalized,
        rootPath: gitTopLevelPath,
        rootKind: "git_worktree",
        originUrl,
        originUrlNormalized
      };
    }
    return MemorySpaceService.createDirectorySpace(gitTopLevelPath);
  }
}
export {
  MemorySpaceService
};
