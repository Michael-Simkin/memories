import { z } from "zod";
const nonEmptyStringSchema = z.string().trim().min(1);
const nullableNonEmptyStringSchema = nonEmptyStringSchema.nullable();
const stringListSchema = z.array(nonEmptyStringSchema);
export {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema,
  stringListSchema
};
