import type {
  ActiveMemorySpaceResolution,
  MemorySpaceKind,
  SpaceRootKind,
} from "../../shared/types/memory-space.js";

export interface PersistedMemorySpace {
  id: string;
  spaceKey: string;
  spaceKind: MemorySpaceKind;
  displayName: string;
  lastSeenRootPath: string;
  originUrl: string | null;
  originUrlNormalized: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface PersistedSpaceRoot {
  id: string;
  spaceId: string;
  rootPath: string;
  rootKind: SpaceRootKind;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface TouchMemorySpaceOptions {
  observedAt?: string | undefined;
}

export interface TouchMemorySpaceResult {
  space: PersistedMemorySpace;
  root: PersistedSpaceRoot;
}

export interface TouchResolvedMemorySpaceInput extends TouchMemorySpaceOptions {
  resolution: ActiveMemorySpaceResolution;
}
