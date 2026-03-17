import { z } from "zod";

import {
  nonEmptyStringSchema,
  stringListSchema,
} from "../../shared/schemas/common.js";

export const recallToolArgumentsSchema = z
  .object({
    query: nonEmptyStringSchema,
    related_paths: stringListSchema.optional(),
  })
  .strict();
