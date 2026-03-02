import { z } from 'zod';

export const sessionStartPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
  })
  .catchall(z.unknown());

export const preToolUsePayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

export const stopPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
    transcript_path: z.string(),
    last_assistant_message: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .catchall(z.unknown());

export const sessionEndPayloadSchema = z
  .object({
    cwd: z.string().optional(),
    project_root: z.string().optional(),
    session_id: z.string().optional(),
  })
  .catchall(z.unknown());
