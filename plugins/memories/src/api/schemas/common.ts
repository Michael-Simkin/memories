import { z } from "zod";

import { nonEmptyStringSchema } from "../../shared/schemas/common.js";
import { currentContextSchema } from "../../shared/schemas/space.js";

export const activeSpaceRequestSchema = z
  .object({
    space_id: nonEmptyStringSchema.optional(),
    context: currentContextSchema.optional(),
  })
  .strict()
  .superRefine((value, refinementContext) => {
    if (value.space_id || value.context) {
      return;
    }

    refinementContext.addIssue({
      code: "custom",
      message: "Request requires either space_id or a resolvable context.",
      path: ["space_id"],
    });
  });

export const activeSpaceContextRequestSchema = z
  .object({
    context: currentContextSchema,
  })
  .strict();
