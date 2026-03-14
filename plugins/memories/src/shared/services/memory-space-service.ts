import { createHash } from "node:crypto";

import { OriginNormalizationService } from "./origin-normalization-service.js";
import type {
  GitInspection,
  MemorySpaceCandidate,
  ResolveMemorySpaceInput,
  SelectedWorkingPath,
  WorkingPathSelectionInput,
  WorkingPathSource,
} from "../types/memory-space.js";
import { normalizeNonEmptyString } from "../utils/strings.js";

export class MemorySpaceService {
  private static createSpaceKey(prefix: "dir" | "remote", discriminator: string): string {
    return createHash("sha256")
      .update(`${prefix}:${discriminator}`, "utf8")
      .digest("hex");
  }

  private static createDirectorySpace(rootPath: string): MemorySpaceCandidate {
    return {
      spaceKind: "directory",
      spaceKey: MemorySpaceService.createSpaceKey("dir", rootPath),
      displayName: rootPath,
      rootPath,
      rootKind: "directory_root",
      originUrl: null,
      originUrlNormalized: null,
    };
  }

  private static requireResolvedPath(value: string | undefined, label: string): string {
    const normalizedValue = normalizeNonEmptyString(value);

    if (!normalizedValue) {
      throw new Error(`${label} must be a non-empty path.`);
    }

    return normalizedValue;
  }

  private static requireGitTopLevelPath(git: GitInspection): string {
    return MemorySpaceService.requireResolvedPath(git.gitTopLevelPath, "gitTopLevelPath");
  }

  static selectWorkingPath(input: WorkingPathSelectionInput): SelectedWorkingPath {
    const orderedSources: Array<[WorkingPathSource, string | undefined]> = [
      ["project_root", normalizeNonEmptyString(input.projectRoot)],
      ["cwd", normalizeNonEmptyString(input.cwd)],
      ["claude_project_dir", normalizeNonEmptyString(input.claudeProjectDir)],
      ["process_cwd", normalizeNonEmptyString(input.processCwd ?? process.cwd())],
    ];

    const selectedSource = orderedSources.find(([, value]) => value !== undefined);

    if (!selectedSource?.[1]) {
      throw new Error("Unable to resolve a working path.");
    }

    return {
      source: selectedSource[0],
      workingPath: selectedSource[1],
    };
  }

  static resolveMemorySpace(input: ResolveMemorySpaceInput): MemorySpaceCandidate {
    const resolvedWorkingPath = MemorySpaceService.requireResolvedPath(
      input.resolvedWorkingPath,
      "resolvedWorkingPath",
    );

    if (!input.git.insideWorkTree) {
      return MemorySpaceService.createDirectorySpace(resolvedWorkingPath);
    }

    const gitTopLevelPath = MemorySpaceService.requireGitTopLevelPath(input.git);
    const originUrl = normalizeNonEmptyString(input.git.originUrl);
    const originUrlNormalized = originUrl
      ? OriginNormalizationService.normalizeOriginUrl(originUrl)
      : null;

    if (originUrl && originUrlNormalized) {
      return {
        spaceKind: "remote_repo",
        spaceKey: MemorySpaceService.createSpaceKey("remote", originUrlNormalized),
        displayName: originUrlNormalized,
        rootPath: gitTopLevelPath,
        rootKind: "git_worktree",
        originUrl,
        originUrlNormalized,
      };
    }

    return MemorySpaceService.createDirectorySpace(gitTopLevelPath);
  }
}
