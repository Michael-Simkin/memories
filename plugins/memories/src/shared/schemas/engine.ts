import { z } from "zod";

import { nonEmptyStringSchema } from "./common.js";

const pidSchema = z.number().int().positive();
const tcpPortSchema = z.number().int().min(1).max(65535);

export const engineLockSchema = z
  .object({
    host: nonEmptyStringSchema,
    port: tcpPortSchema,
    pid: pidSchema,
    started_at: nonEmptyStringSchema,
    last_activity_at: nonEmptyStringSchema,
    storage_root: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
  })
  .strict();

export const engineStartupLockSchema = z
  .object({
    pid: pidSchema,
    acquired_at: nonEmptyStringSchema,
    storage_root: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
  })
  .strict();
