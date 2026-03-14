import type { SpaceKind } from "./space.js";

export type MemorySpaceKind = SpaceKind;
export type SpaceRootKind = "git_worktree" | "directory_root";
export type WorkingPathSource =
  | "project_root"
  | "cwd"
  | "claude_project_dir"
  | "process_cwd";

export interface WorkingPathSelectionInput {
  projectRoot?: string | undefined;
  cwd?: string | undefined;
  claudeProjectDir?: string | undefined;
  processCwd?: string | undefined;
}

export interface SelectedWorkingPath {
  source: WorkingPathSource;
  workingPath: string;
}

export interface ResolvedWorkingContext {
  source: WorkingPathSource;
  selectedWorkingPath: string;
  resolvedWorkingPath: string;
}

export interface GitInspection {
  insideWorkTree: boolean;
  gitTopLevelPath?: string | undefined;
  originUrl?: string | null | undefined;
}

export interface ResolveMemorySpaceInput {
  resolvedWorkingPath: string;
  git: GitInspection;
}

export interface MemorySpaceCandidate {
  spaceKind: MemorySpaceKind;
  spaceKey: string;
  displayName: string;
  rootPath: string;
  rootKind: SpaceRootKind;
  originUrl: string | null;
  originUrlNormalized: string | null;
}

export interface ActiveMemorySpaceResolution {
  workingContext: ResolvedWorkingContext;
  git: GitInspection;
  space: MemorySpaceCandidate;
}
