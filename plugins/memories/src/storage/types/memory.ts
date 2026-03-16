import type {
  MemorySearchResponse,
  MemoryRecord,
  MemoryType,
  PinnedMemoriesResult,
} from "../../shared/types/memory.js";

export interface CreateMemoryInput {
  id?: string | undefined;
  spaceId: string;
  memoryType: MemoryType;
  content: string;
  tags?: string[] | undefined;
  isPinned?: boolean | undefined;
  pathMatchers?: string[] | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface UpdateMemoryInput {
  memoryId: string;
  content?: string | undefined;
  tags?: string[] | undefined;
  isPinned?: boolean | undefined;
  pathMatchers?: string[] | undefined;
  updatedAt?: string | undefined;
}

export interface ListMemoriesOptions {
  spaceId: string;
}

export interface ListPinnedMemoriesOptions {
  spaceId: string;
}

export interface SearchMemoriesByTagsOptions {
  query: string;
  spaceId: string;
  limit?: number | undefined;
}

export interface DeleteMemoryOptions {
  memoryId: string;
}

export type PersistedMemoryRecord = MemoryRecord;
export type PersistedMemorySearchResponse = MemorySearchResponse;
export type PersistedPinnedMemoriesResult = PinnedMemoriesResult;
