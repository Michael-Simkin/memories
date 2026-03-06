import { z } from 'zod';

import {
  DEFAULT_LEXICAL_K,
  DEFAULT_RESPONSE_TOKEN_BUDGET,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SEMANTIC_K,
  MAX_SEARCH_LIMIT,
  MEMORY_TYPES,
} from './constants.js';

export const memoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const pathMatcherSchema = z.object({
  path_matcher: z.string().trim().min(1).max(512),
});
export type PathMatcherInput = z.infer<typeof pathMatcherSchema>;

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  memory_type: memoryTypeSchema,
  content: z.string().min(1),
  tags: z.array(z.string()),
  is_pinned: z.boolean(),
  path_matchers: z.array(pathMatcherSchema),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const addMemoryInputSchema = z.object({
  memory_type: memoryTypeSchema,
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([]),
});
export type AddMemoryInput = z.infer<typeof addMemoryInputSchema>;

export const updateMemoryInputSchema = z
  .object({
    content: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    is_pinned: z.boolean().optional(),
    path_matchers: z.array(pathMatcherSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be updated');
export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;

export const searchRequestSchema = z.object({
  query: z.string().default(''),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  target_paths: z.array(z.string()).default([]),
  memory_types: z.array(memoryTypeSchema).optional(),
  include_pinned: z.boolean().default(true),
  semantic_k: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEMANTIC_K),
  lexical_k: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_LEXICAL_K),
  response_token_budget: z
    .number()
    .int()
    .min(200)
    .max(20_000)
    .default(DEFAULT_RESPONSE_TOKEN_BUDGET),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchMatchSourceSchema = z.enum(['path', 'lexical', 'semantic']);
export type SearchMatchSource = z.infer<typeof searchMatchSourceSchema>;

export const searchResultSchema = z.object({
  id: z.string(),
  memory_type: memoryTypeSchema,
  content: z.string(),
  tags: z.array(z.string()),
  is_pinned: z.boolean(),
  path_matchers: z.array(z.string()),
  score: z.number().min(0).max(1),
  source: z.enum(['path', 'hybrid']),
  matched_by: z.array(searchMatchSourceSchema).optional(),
  path_score: z.number().min(0).max(1).optional(),
  lexical_score: z.number().min(0).max(1).optional(),
  semantic_score: z.number().min(0).max(1).optional(),
  rrf_score: z.number().nonnegative().optional(),
  updated_at: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  meta: z.object({
    query: z.string(),
    returned: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    source: z.literal('hybrid'),
  }),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const memoryEventLogSchema = z.object({
  at: z.string().min(1),
  event: z.string().min(1),
  status: z.enum(['ok', 'error', 'skipped']),
  kind: z.enum(['hook', 'operation', 'system']),
  session_id: z.string().optional(),
  memory_id: z.string().optional(),
  detail: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type MemoryEventLog = z.infer<typeof memoryEventLogSchema>;

const createActionSchema = z.object({
  action: z.literal('create'),
  confidence: z.number().min(0).max(1),
  memory_type: memoryTypeSchema,
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([]),
});

const updateFieldsSchema = z
  .object({
    content: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    is_pinned: z.boolean().optional(),
    path_matchers: z.array(pathMatcherSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Update action requires at least one field');

const updateActionSchema = z.object({
  action: z.literal('update'),
  confidence: z.number().min(0).max(1),
  memory_id: z.string().trim().min(1),
  updates: updateFieldsSchema,
});

const deleteActionSchema = z.object({
  action: z.literal('delete'),
  confidence: z.number().min(0).max(1),
  memory_id: z.string().trim().min(1),
});

const skipActionSchema = z.object({
  action: z.literal('skip'),
  confidence: z.number().min(0).max(1).default(1),
  reason: z.string().optional(),
});

export const extractionActionSchema = z.discriminatedUnion('action', [
  createActionSchema,
  updateActionSchema,
  deleteActionSchema,
  skipActionSchema,
]);
export type ExtractionAction = z.infer<typeof extractionActionSchema>;

export const extractionActionsPayloadSchema = z.object({
  actions: z.array(extractionActionSchema).default([]),
});
export type ExtractionActionsPayload = z.infer<typeof extractionActionsPayloadSchema>;
