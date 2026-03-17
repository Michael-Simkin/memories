import { z } from "zod";

import {
  nonEmptyStringSchema,
  stringListSchema,
} from "../shared/schemas/common.js";
import { memoryTypeSchema } from "../shared/schemas/memory.js";

export const learningActionConfidenceSchema = z.enum(["low", "medium", "high"]);

const learningActionBaseSchema = z
  .object({
    confidence: learningActionConfidenceSchema,
    reason: nonEmptyStringSchema,
  })
  .strict();

export const createMemoryLearningActionSchema = learningActionBaseSchema
  .extend({
    type: z.literal("create"),
    memory_type: memoryTypeSchema,
    content: nonEmptyStringSchema,
    tags: stringListSchema,
    is_pinned: z.boolean(),
    path_matchers: stringListSchema,
  })
  .strict();

export const updateMemoryLearningActionSchema = learningActionBaseSchema
  .extend({
    type: z.literal("update"),
    memory_id: nonEmptyStringSchema,
    memory_type: memoryTypeSchema.optional(),
    content: nonEmptyStringSchema.optional(),
    tags: stringListSchema.optional(),
    is_pinned: z.boolean().optional(),
    path_matchers: stringListSchema.optional(),
  })
  .strict()
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
      message: "Update actions must change at least one memory field.",
      path: ["memory_id"],
    });
  });

export const deleteMemoryLearningActionSchema = learningActionBaseSchema
  .extend({
    type: z.literal("delete"),
    memory_id: nonEmptyStringSchema,
  })
  .strict();

export const memoryLearningActionSchema = z.discriminatedUnion("type", [
  createMemoryLearningActionSchema,
  updateMemoryLearningActionSchema,
  deleteMemoryLearningActionSchema,
]);

export const learningActionDocumentSchema = z
  .object({
    summary: nonEmptyStringSchema,
    actions: z.array(memoryLearningActionSchema).max(50),
  })
  .strict();

export type MemoryLearningAction = z.infer<typeof memoryLearningActionSchema>;
export type LearningActionDocument = z.infer<typeof learningActionDocumentSchema>;

export const learningActionDocumentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "actions"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
    },
    actions: {
      type: "array",
      maxItems: 50,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: [
              "type",
              "confidence",
              "reason",
              "memory_type",
              "content",
              "tags",
              "is_pinned",
              "path_matchers",
            ],
            properties: {
              type: {
                const: "create",
              },
              confidence: {
                enum: ["low", "medium", "high"],
              },
              reason: {
                type: "string",
                minLength: 1,
              },
              memory_type: {
                enum: ["fact", "rule", "decision", "episode"],
              },
              content: {
                type: "string",
                minLength: 1,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                  minLength: 1,
                },
              },
              is_pinned: {
                type: "boolean",
              },
              path_matchers: {
                type: "array",
                items: {
                  type: "string",
                  minLength: 1,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "confidence", "reason", "memory_id"],
            allOf: [
              {
                anyOf: [
                  {
                    required: ["memory_type"],
                  },
                  {
                    required: ["content"],
                  },
                  {
                    required: ["tags"],
                  },
                  {
                    required: ["is_pinned"],
                  },
                  {
                    required: ["path_matchers"],
                  },
                ],
              },
            ],
            properties: {
              type: {
                const: "update",
              },
              confidence: {
                enum: ["low", "medium", "high"],
              },
              reason: {
                type: "string",
                minLength: 1,
              },
              memory_id: {
                type: "string",
                minLength: 1,
              },
              memory_type: {
                enum: ["fact", "rule", "decision", "episode"],
              },
              content: {
                type: "string",
                minLength: 1,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                  minLength: 1,
                },
              },
              is_pinned: {
                type: "boolean",
              },
              path_matchers: {
                type: "array",
                items: {
                  type: "string",
                  minLength: 1,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "confidence", "reason", "memory_id"],
            properties: {
              type: {
                const: "delete",
              },
              confidence: {
                enum: ["low", "medium", "high"],
              },
              reason: {
                type: "string",
                minLength: 1,
              },
              memory_id: {
                type: "string",
                minLength: 1,
              },
            },
          },
        ],
      },
    },
  },
} as const;
