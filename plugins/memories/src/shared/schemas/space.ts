import { z } from "zod";

import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema,
} from "./common.js";

export const spaceKindSchema = z.enum(["remote_repo", "directory"]);

export const currentContextSchema = z
  .object({
    project_root: nonEmptyStringSchema.optional(),
    cwd: nonEmptyStringSchema.optional(),
  })
  .strict();

export const spaceMetadataSchema = z
  .object({
    space_id: nonEmptyStringSchema,
    space_kind: spaceKindSchema,
    space_display_name: nonEmptyStringSchema,
    origin_url_normalized: nullableNonEmptyStringSchema,
  })
  .strict();
