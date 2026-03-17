import { z } from "zod";

import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema,
} from "./common.js";
import { spaceKindSchema } from "./space.js";

export const eventKindSchema = z.enum([
  "engine",
  "space",
  "memory",
  "retrieval",
  "learning_job",
  "hook",
  "mcp",
  "ui",
  "api",
  "storage",
]);

export const eventStatusSchema = z.enum(["info", "success", "warning", "error"]);

export const eventRecordSchema = z
  .object({
    at: nonEmptyStringSchema,
    space_id: nullableNonEmptyStringSchema,
    space_kind: spaceKindSchema.nullable(),
    space_display_name: nullableNonEmptyStringSchema,
    origin_url_normalized: nullableNonEmptyStringSchema,
    root_path: nullableNonEmptyStringSchema,
    event: nonEmptyStringSchema,
    kind: eventKindSchema,
    status: eventStatusSchema,
    session_id: nullableNonEmptyStringSchema,
    memory_id: nullableNonEmptyStringSchema,
    job_id: nullableNonEmptyStringSchema,
    detail: nullableNonEmptyStringSchema,
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
