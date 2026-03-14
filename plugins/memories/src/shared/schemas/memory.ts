import { z } from "zod";

import {
  nonEmptyStringSchema,
  stringListSchema,
} from "./common.js";
import {
  currentContextSchema,
  spaceMetadataSchema,
} from "./space.js";

export const memoryTypeSchema = z.enum(["fact", "rule", "decision", "episode"]);
export const searchSourceSchema = z.enum(["path", "lexical", "semantic", "hybrid"]);

export const memoryRecordSchema = spaceMetadataSchema
  .extend({
    id: nonEmptyStringSchema,
    memory_type: memoryTypeSchema,
    content: nonEmptyStringSchema,
    tags: stringListSchema,
    is_pinned: z.boolean(),
    path_matchers: stringListSchema,
    created_at: nonEmptyStringSchema,
    updated_at: nonEmptyStringSchema,
  })
  .strict();

export const memorySearchResultSchema = memoryRecordSchema
  .extend({
    score: z.number(),
    source: searchSourceSchema,
    matched_by: z.array(searchSourceSchema).min(1),
    path_score: z.number().nullable(),
    lexical_score: z.number().nullable(),
    semantic_score: z.number().nullable(),
  })
  .strict();

export const pinnedMemoriesRequestSchema = z
  .object({
    space_id: nonEmptyStringSchema.optional(),
    context: currentContextSchema.optional(),
  })
  .strict()
  .superRefine((value, refinementContext) => {
    if (value.space_id || value.context) {
      return;
    }

    refinementContext.addIssue({
      code: "custom",
      message: "Pinned memory lookup requires either space_id or a resolvable context.",
      path: ["space_id"],
    });
  });

export const pinnedMemoriesResultSchema = z
  .object({
    space: spaceMetadataSchema,
    memories: z.array(memoryRecordSchema),
  })
  .strict();

export const memorySearchRequestSchema = z
  .object({
    query: nonEmptyStringSchema,
    limit: z.number().int().positive().max(100).default(10),
    space_id: nonEmptyStringSchema.optional(),
    context: currentContextSchema.optional(),
  })
  .strict();

export const memorySearchResponseSchema = z
  .object({
    space: spaceMetadataSchema,
    results: z.array(memorySearchResultSchema),
  })
  .strict();
