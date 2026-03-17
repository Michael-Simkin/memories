import type { z } from "zod";

import type { engineHealthSchema } from "../schemas/health.js";

export type EngineHealth = z.infer<typeof engineHealthSchema>;

export type EngineHealthCompatibilityReason =
  | "invalid_payload"
  | "engine_version_mismatch"
  | "api_contract_version_mismatch"
  | "db_schema_version_mismatch";

export interface EngineHealthCompatibilityResult {
  isCompatible: boolean;
  reason?: EngineHealthCompatibilityReason | undefined;
  expected: EngineHealth;
  actual: EngineHealth | null;
}
