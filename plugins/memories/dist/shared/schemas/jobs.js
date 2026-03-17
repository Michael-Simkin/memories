import { z } from "zod";
import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema
} from "./common.js";
const learningJobStateSchema = z.enum([
  "pending",
  "leased",
  "running",
  "completed",
  "failed",
  "skipped"
]);
const learningJobSchema = z.object({
  id: nonEmptyStringSchema,
  space_id: nonEmptyStringSchema,
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
  updated_at: nonEmptyStringSchema
}).strict();
export {
  learningJobSchema,
  learningJobStateSchema
};
