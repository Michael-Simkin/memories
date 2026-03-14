import type { z } from "zod";

import type {
  memoryRecordSchema,
  memorySearchRequestSchema,
  memorySearchResponseSchema,
  memorySearchResultSchema,
  memoryTypeSchema,
  pinnedMemoriesRequestSchema,
  pinnedMemoriesResultSchema,
  searchSourceSchema,
} from "../schemas/memory.js";

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type PinnedMemoriesRequest = z.infer<typeof pinnedMemoriesRequestSchema>;
export type PinnedMemoriesResult = z.infer<typeof pinnedMemoriesResultSchema>;
export type SearchSource = z.infer<typeof searchSourceSchema>;
