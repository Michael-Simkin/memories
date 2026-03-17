import { z } from "zod";
import { nonEmptyStringSchema } from "./common.js";
const engineHealthSchema = z.object({
  engine_version: nonEmptyStringSchema,
  api_contract_version: z.number().int().positive(),
  db_schema_version: z.number().int().nonnegative()
}).strict();
export {
  engineHealthSchema
};
