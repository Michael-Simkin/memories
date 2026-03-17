import { z } from "zod";
import {
  nonEmptyStringSchema,
  nullableNonEmptyStringSchema
} from "./common.js";
const eventKindSchema = z.enum([
  "engine",
  "space",
  "memory",
  "retrieval",
  "learning_job",
  "hook",
  "mcp",
  "ui",
  "api",
  "storage"
]);
const eventStatusSchema = z.enum(["info", "success", "warning", "error"]);
const eventRecordSchema = z.object({
  at: nonEmptyStringSchema,
  space_id: nullableNonEmptyStringSchema,
  root_path: nullableNonEmptyStringSchema,
  event: nonEmptyStringSchema,
  kind: eventKindSchema,
  status: eventStatusSchema,
  session_id: nullableNonEmptyStringSchema,
  memory_id: nullableNonEmptyStringSchema,
  job_id: nullableNonEmptyStringSchema,
  detail: nullableNonEmptyStringSchema,
  data: z.record(z.string(), z.unknown()).nullable()
}).strict();
export {
  eventKindSchema,
  eventRecordSchema,
  eventStatusSchema
};
