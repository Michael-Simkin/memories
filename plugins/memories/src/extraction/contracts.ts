import { z } from 'zod';

import { memoryTypeSchema, pathMatcherSchema } from '../shared/types.js';

export const workerPayloadSchema = z.object({
  background_hook_id: z.string().trim().min(1).optional(),
  endpoint: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
  }),
  project_root: z.string().min(1),
  transcript_path: z.string().min(1),
  last_assistant_message: z.string().optional(),
  session_id: z.string().optional(),
});

const updateFieldsSchema = z
  .object({
    content: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    is_pinned: z.boolean().optional(),
    path_matchers: z.array(pathMatcherSchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Update action must include at least one field');

const createActionSchema = z.object({
  action: z.literal('create'),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  memory_type: memoryTypeSchema,
  content: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z.array(pathMatcherSchema).default([]),
});

const updateActionSchema = z.object({
  action: z.literal('update'),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  memory_id: z.string().trim().min(1),
  updates: updateFieldsSchema,
});

const deleteActionSchema = z.object({
  action: z.literal('delete'),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
  memory_id: z.string().trim().min(1),
});

const skipActionSchema = z.object({
  action: z.literal('skip'),
  confidence: z.number().min(0).max(1).default(1),
  reason: z.string().optional(),
});

export const workerActionSchema = z.discriminatedUnion('action', [
  createActionSchema,
  updateActionSchema,
  deleteActionSchema,
  skipActionSchema,
]);
export type WorkerAction = z.infer<typeof workerActionSchema>;

export const workerOutputSchema = z.object({
  actions: z.array(workerActionSchema),
});

export type WorkerPayload = z.infer<typeof workerPayloadSchema>;
