import { z } from 'zod';

import { MEMORY_TYPES } from './constants.js';

export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const pathMatcherSchema = z.object({
  path_matcher: z.string().min(1),
  priority: z.number().int().min(0).max(1000).default(100),
});
export type PathMatcherInput = z.infer<typeof pathMatcherSchema>;

export const memorySchema = z.object({
  id: z.string().min(1),
  memory_type: memoryTypeSchema,
  content: z.string().min(1),
  tags: z.array(z.string()),
  is_pinned: z.boolean(),
  path_matchers: z.array(pathMatcherSchema),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type MemoryRecord = z.infer<typeof memorySchema>;

export const searchRequestSchema = z.object({
  query: z.string().default(''),
  limit: z.number().int().min(1).max(50).default(10),
  memory_types: z.array(memoryTypeSchema).optional(),
  include_pinned: z.boolean().default(true),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchResultSchema = z.object({
  id: z.string(),
  memory_type: memoryTypeSchema,
  content: z.string(),
  tags: z.array(z.string()),
  score: z.number(),
  is_pinned: z.boolean(),
  updated_at: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  meta: z.object({
    query: z.string(),
    returned: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    source: z.string(),
  }),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const addMemorySchema = z.object({
  memory_type: memoryTypeSchema,
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([]),
});
export type AddMemoryInput = z.infer<typeof addMemorySchema>;

export const updateMemorySchema = z
  .object({
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    is_pinned: z.boolean().optional(),
    path_matchers: z.array(pathMatcherSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be updated');
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

export const retrievalPretoolSchema = z.object({
  query: z.string().default(''),
  target_paths: z.array(z.string()).default([]),
  max_tokens: z.number().int().min(100).max(20000).default(6000),
});
export type RetrievalPretoolInput = z.infer<typeof retrievalPretoolSchema>;

export const hookEventLogSchema = z.object({
  at: z.string(),
  event: z.string(),
  status: z.enum(['ok', 'error', 'skipped']),
  session_id: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type HookEventLog = z.infer<typeof hookEventLogSchema>;

export const operationLogSchema = z.object({
  at: z.string(),
  op: z.string(),
  status: z.enum(['ok', 'error', 'skipped']),
  memory_id: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type OperationLog = z.infer<typeof operationLogSchema>;
