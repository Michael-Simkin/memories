import {
  CLAUDE_MEMORY_API_CONTRACT_VERSION,
  CLAUDE_MEMORY_VERSION
} from "../constants/version.js";
import { engineHealthSchema } from "../schemas/health.js";
class EngineHealthService {
  static createExpectedHealth(dbSchemaVersion) {
    return engineHealthSchema.parse({
      engine_version: CLAUDE_MEMORY_VERSION,
      api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION,
      db_schema_version: dbSchemaVersion
    });
  }
  static parseHealth(value) {
    return engineHealthSchema.parse(value);
  }
  static evaluateCompatibility(actualValue, dbSchemaVersion) {
    const expectedHealth = EngineHealthService.createExpectedHealth(dbSchemaVersion);
    let actualHealth;
    try {
      actualHealth = EngineHealthService.parseHealth(actualValue);
    } catch {
      return {
        isCompatible: false,
        reason: "invalid_payload",
        expected: expectedHealth,
        actual: null
      };
    }
    if (actualHealth.engine_version !== expectedHealth.engine_version) {
      return {
        isCompatible: false,
        reason: "engine_version_mismatch",
        expected: expectedHealth,
        actual: actualHealth
      };
    }
    if (actualHealth.api_contract_version !== expectedHealth.api_contract_version) {
      return {
        isCompatible: false,
        reason: "api_contract_version_mismatch",
        expected: expectedHealth,
        actual: actualHealth
      };
    }
    if (actualHealth.db_schema_version !== expectedHealth.db_schema_version) {
      return {
        isCompatible: false,
        reason: "db_schema_version_mismatch",
        expected: expectedHealth,
        actual: actualHealth
      };
    }
    return {
      isCompatible: true,
      expected: expectedHealth,
      actual: actualHealth
    };
  }
}
export {
  EngineHealthService
};
