import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema,
} from "../../shared/schemas/common.js";
import { activeSpaceRequestSchema } from "./common.js";

export const enqueueLearningJobRequestSchema = activeSpaceRequestSchema.extend({
  last_assistant_message: nullableNonEmptyStringSchema.optional(),
  session_id: nullableNonEmptyStringSchema.optional(),
  transcript_path: nonEmptyStringSchema,
});
