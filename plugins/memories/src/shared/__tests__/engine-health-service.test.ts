import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAUDE_MEMORY_API_CONTRACT_VERSION,
  CLAUDE_MEMORY_VERSION,
} from "../constants/version.js";
import { EngineHealthService } from "../services/engine-health-service.js";
import { DatabaseBootstrapRepository } from "../../storage/repositories/database-bootstrap-repository.js";

describe("EngineHealthService", () => {
  it("builds the expected health contract from shared version constants", () => {
    const latestSchemaVersion = DatabaseBootstrapRepository.getLatestSchemaVersion();
    const expectedHealth = EngineHealthService.createExpectedHealth(latestSchemaVersion);

    assert.deepEqual(expectedHealth, {
      engine_version: CLAUDE_MEMORY_VERSION,
      api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION,
      db_schema_version: latestSchemaVersion,
    });
  });

  it("accepts a matching health payload as compatible", () => {
    const compatibilityResult = EngineHealthService.evaluateCompatibility(
      {
        engine_version: CLAUDE_MEMORY_VERSION,
        api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION,
        db_schema_version: DatabaseBootstrapRepository.getLatestSchemaVersion(),
      },
      DatabaseBootstrapRepository.getLatestSchemaVersion(),
    );

    assert.equal(compatibilityResult.isCompatible, true);
    assert.equal(compatibilityResult.reason, undefined);
    assert.deepEqual(compatibilityResult.actual, compatibilityResult.expected);
  });

  it("rejects invalid health payloads", () => {
    const latestSchemaVersion = DatabaseBootstrapRepository.getLatestSchemaVersion();
    const compatibilityResult = EngineHealthService.evaluateCompatibility(
      {
        engine_version: CLAUDE_MEMORY_VERSION,
      },
      latestSchemaVersion,
    );

    assert.deepEqual(compatibilityResult, {
      isCompatible: false,
      reason: "invalid_payload",
      expected: {
        engine_version: CLAUDE_MEMORY_VERSION,
        api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION,
        db_schema_version: latestSchemaVersion,
      },
      actual: null,
    });
  });

  it("rejects mismatched engine versions", () => {
    const compatibilityResult = EngineHealthService.evaluateCompatibility(
      {
        engine_version: "0.0.1",
        api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION,
        db_schema_version: DatabaseBootstrapRepository.getLatestSchemaVersion(),
      },
      DatabaseBootstrapRepository.getLatestSchemaVersion(),
    );

    assert.equal(compatibilityResult.isCompatible, false);
    assert.equal(compatibilityResult.reason, "engine_version_mismatch");
  });

  it("rejects mismatched API contract versions", () => {
    const compatibilityResult = EngineHealthService.evaluateCompatibility(
      {
        engine_version: CLAUDE_MEMORY_VERSION,
        api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION + 1,
        db_schema_version: DatabaseBootstrapRepository.getLatestSchemaVersion(),
      },
      DatabaseBootstrapRepository.getLatestSchemaVersion(),
    );

    assert.equal(compatibilityResult.isCompatible, false);
    assert.equal(compatibilityResult.reason, "api_contract_version_mismatch");
  });

  it("rejects mismatched database schema versions", () => {
    const compatibilityResult = EngineHealthService.evaluateCompatibility(
      {
        engine_version: CLAUDE_MEMORY_VERSION,
        api_contract_version: CLAUDE_MEMORY_API_CONTRACT_VERSION,
        db_schema_version: DatabaseBootstrapRepository.getLatestSchemaVersion() + 1,
      },
      DatabaseBootstrapRepository.getLatestSchemaVersion(),
    );

    assert.equal(compatibilityResult.isCompatible, false);
    assert.equal(compatibilityResult.reason, "db_schema_version_mismatch");
  });
});
