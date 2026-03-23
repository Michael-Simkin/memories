import { z } from 'zod';

export const sessionStartPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    source: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    agent_type: z.string().trim().min(1).optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
  })
  .catchall(z.unknown());

export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;

export const userPromptSubmitPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    prompt: z.string().optional(),
    session_id: z.string().optional(),
  })
  .catchall(z.unknown());

export type UserPromptSubmitPayload = z.infer<typeof userPromptSubmitPayloadSchema>;

export const stopPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
    transcript_path: z.string().trim().min(1),
    last_assistant_message: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .catchall(z.unknown());

export type StopPayload = z.infer<typeof stopPayloadSchema>;
