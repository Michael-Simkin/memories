import type { z } from "zod";

import type {
  engineLockSchema,
  engineStartupLockSchema,
} from "../schemas/engine.js";

export type EngineLock = z.infer<typeof engineLockSchema>;
export type EngineStartupLock = z.infer<typeof engineStartupLockSchema>;

export interface WriteEngineLockInput {
  host: string;
  port: number;
  pid: number;
  started_at: string;
  last_activity_at: string;
  version: string;
}

export interface WriteEngineStartupLockInput {
  pid: number;
  acquired_at: string;
  version: string;
}
