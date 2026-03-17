import type {
  MemorySearchResponse,
  MemoryRecord,
  MemoryType,
  PinnedMemoriesResult,
} from "../../shared/types/memory.js";
import type { CurrentContext } from "../../shared/types/space.js";

export interface CreateMemoryInput {
  id?: string | undefined;
  spaceId: string;
  memoryType: MemoryType;
  content: string;
  tags?: string[] | undefined;
  isPinned?: boolean | undefined;
  pathMatchers?: string[] | undefined;
  semanticEmbedding?: number[] | null | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface CreateActiveMemoryInput extends ResolveActiveSpaceOptions {
  id?: string | undefined;
  memoryType: MemoryType;
  content: string;
  tags?: string[] | undefined;
  isPinned?: boolean | undefined;
  pathMatchers?: string[] | undefined;
  semanticEmbedding?: number[] | null | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface UpdateMemoryInput {
  memoryId: string;
  memoryType?: MemoryType | undefined;
  content?: string | undefined;
  tags?: string[] | undefined;
  isPinned?: boolean | undefined;
  pathMatchers?: string[] | undefined;
  semanticEmbedding?: number[] | null | undefined;
  updatedAt?: string | undefined;
}

export interface UpdateActiveMemoryInput extends ResolveActiveSpaceOptions {
  memoryId: string;
  memoryType?: MemoryType | undefined;
  content?: string | undefined;
  tags?: string[] | undefined;
  isPinned?: boolean | undefined;
  pathMatchers?: string[] | undefined;
  semanticEmbedding?: number[] | null | undefined;
  updatedAt?: string | undefined;
}

export interface ListMemoriesOptions {
  spaceId?: string | undefined;
  limit?: number | undefined;
}

export interface ListPinnedMemoriesOptions {
  spaceId: string;
}

export interface SearchMemoriesByTagsOptions {
  query: string;
  spaceId: string;
  limit?: number | undefined;
}

export interface SearchMemoriesByPathsOptions {
  relatedPaths: string[];
  spaceId: string;
  limit?: number | undefined;
}

export interface SearchMemoriesBySemanticOptions {
  queryEmbedding: number[];
  spaceId: string;
  limit?: number | undefined;
}

export interface SearchMemoriesOptions {
  query?: string | undefined;
  queryEmbedding?: number[] | undefined;
  relatedPaths?: string[] | undefined;
  spaceId: string;
  limit?: number | undefined;
}

export interface SearchAllMemoriesOptions {
  query?: string | undefined;
  queryEmbedding?: number[] | undefined;
  limit?: number | undefined;
}

export interface ResolveActiveSpaceOptions {
  spaceId?: string | undefined;
  context?: CurrentContext | undefined;
}

export type ListActivePinnedMemoriesOptions = ResolveActiveSpaceOptions;

export interface SearchActiveMemoriesOptions extends ResolveActiveSpaceOptions {
  query?: string | undefined;
  queryEmbedding?: number[] | undefined;
  relatedPaths?: string[] | undefined;
  limit?: number | undefined;
}

export interface DeleteActiveMemoryOptions extends ResolveActiveSpaceOptions {
  memoryId: string;
}

export interface DeleteMemoryOptions {
  memoryId: string;
}

export type PersistedMemoryRecord = MemoryRecord;
export type PersistedMemorySearchResponse = MemorySearchResponse;
export type PersistedPinnedMemoriesResult = PinnedMemoriesResult;
