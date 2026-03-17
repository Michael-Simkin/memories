import { z } from "zod";

import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema,
} from "../../shared/schemas/common.js";

export const commonHookInputSchema = z
  .object({
    session_id: nullableNonEmptyStringSchema,
    transcript_path: nonEmptyStringSchema,
    cwd: nonEmptyStringSchema,
  })
  .strict();
