import { z } from "zod";

import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema,
} from "./common.js";
import { spaceKindSchema } from "./space.js";

export const learningJobStateSchema = z.enum([
  "pending",
  "leased",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export const learningJobSchema = z
  .object({
    id: nonEmptyStringSchema,
    space_id: nonEmptyStringSchema,
    space_kind: spaceKindSchema.nullable(),
    space_display_name: nullableNonEmptyStringSchema,
    origin_url_normalized: nullableNonEmptyStringSchema,
    root_path: nonEmptyStringSchema,
    transcript_path: nonEmptyStringSchema,
    last_assistant_message: nullableNonEmptyStringSchema,
    session_id: nullableNonEmptyStringSchema,
    state: learningJobStateSchema,
    lease_owner: nullableNonEmptyStringSchema,
    lease_expires_at: nullableNonEmptyStringSchema,
    attempt_count: z.number().int().nonnegative(),
    error_text: nullableNonEmptyStringSchema,
    enqueued_at: nonEmptyStringSchema,
    started_at: nullableNonEmptyStringSchema,
    finished_at: nullableNonEmptyStringSchema,
    updated_at: nonEmptyStringSchema,
  })
  .strict();
