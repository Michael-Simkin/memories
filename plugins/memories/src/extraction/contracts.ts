import { z } from 'zod';

import { memoryTypeSchema, pathMatcherSchema } from '../shared/types.js';

export const memoryActionSchema = z
  .object({
    action: z.enum(['create', 'update', 'delete', 'skip']),
    memory_type: memoryTypeSchema,
    id: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).default([]),
    is_pinned: z.boolean().default(false),
    path_matchers: z.array(pathMatcherSchema).default([]),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    evidence: z.array(z.string()).default([]),
  })
  .superRefine((value, context) => {
    if (value.action === 'create' && value.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'create action must not include id',
      });
    }
    if ((value.action === 'update' || value.action === 'delete') && !value.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} action requires id`,
      });
    }
    if ((value.action === 'create' || value.action === 'update') && !value.content) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} action requires content`,
      });
    }
  });

export type MemoryAction = z.infer<typeof memoryActionSchema>;

export const extractionOutputSchema = z.object({
  actions: z.array(memoryActionSchema),
});

export const workerPayloadSchema = z.object({
  endpoint: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  project_root: z.string().min(1),
  transcript_path: z.string().min(1),
  last_assistant_message: z.string().optional(),
  session_id: z.string().optional(),
});

export type WorkerPayload = z.infer<typeof workerPayloadSchema>;
