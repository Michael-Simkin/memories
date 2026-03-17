import { z } from "zod";

import {
  nonEmptyStringSchema,
  stringListSchema,
} from "../../shared/schemas/common.js";
import {
  memoryTypeSchema,
  pinnedMemoriesRequestSchema,
} from "../../shared/schemas/memory.js";
import { activeSpaceRequestSchema } from "./common.js";

export const apiPinnedMemoriesRequestSchema = pinnedMemoriesRequestSchema;

export const apiSearchMemoriesRequestSchema = activeSpaceRequestSchema.extend({
  query: nonEmptyStringSchema,
  limit: z.number().int().positive().max(100).default(10),
  related_paths: stringListSchema.optional(),
});

export const apiCreateMemoryRequestSchema = activeSpaceRequestSchema.extend({
  memory_type: memoryTypeSchema,
  content: nonEmptyStringSchema,
  tags: stringListSchema.optional(),
  is_pinned: z.boolean().optional(),
  path_matchers: stringListSchema.optional(),
});

export const apiUpdateMemoryRequestSchema = activeSpaceRequestSchema
  .extend({
    memory_type: memoryTypeSchema.optional(),
    content: nonEmptyStringSchema.optional(),
    tags: stringListSchema.optional(),
    is_pinned: z.boolean().optional(),
    path_matchers: stringListSchema.optional(),
  })
  .superRefine((value, refinementContext) => {
    if (
      value.memory_type !== undefined ||
      value.content !== undefined ||
      value.tags !== undefined ||
      value.is_pinned !== undefined ||
      value.path_matchers !== undefined
    ) {
      return;
    }

    refinementContext.addIssue({
      code: "custom",
      message: "Memory update requires at least one editable field.",
      path: ["content"],
    });
  });

export const apiDeleteMemoryRequestSchema = activeSpaceRequestSchema;
