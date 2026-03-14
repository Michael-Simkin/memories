import { z } from "zod";

export const nonEmptyStringSchema = z.string().trim().min(1);
export const nullableNonEmptyStringSchema = nonEmptyStringSchema.nullable();
export const stringListSchema = z.array(nonEmptyStringSchema);
