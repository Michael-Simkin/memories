import { z } from "zod";
import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema
} from "./common.js";
const spaceKindSchema = z.enum(["remote_repo", "directory"]);
const currentContextSchema = z.object({
  project_root: nonEmptyStringSchema.optional(),
  cwd: nonEmptyStringSchema.optional()
}).strict();
const spaceMetadataSchema = z.object({
  space_id: nonEmptyStringSchema,
  space_kind: spaceKindSchema,
  space_display_name: nonEmptyStringSchema,
  origin_url_normalized: nullableNonEmptyStringSchema
}).strict();
export {
  currentContextSchema,
  spaceKindSchema,
  spaceMetadataSchema
};
