const DEFAULT_ENGINE_BOOT_TIMEOUT_MS = 15e3;
const DEFAULT_ENGINE_IDLE_TIMEOUT_MS = 60 * 60 * 1e3;
function resolvePositiveInteger(value, defaultValue, envName) {
  if (value === void 0) {
    return defaultValue;
  }
  const numericValue = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${envName} must be a positive integer.`);
  }
  return numericValue;
}
function resolveEngineBootTimeoutMs(configuredTimeoutMs) {
  return resolvePositiveInteger(
    configuredTimeoutMs ?? process.env["MEMORIES_ENGINE_BOOT_TIMEOUT_MS"],
    DEFAULT_ENGINE_BOOT_TIMEOUT_MS,
    "MEMORIES_ENGINE_BOOT_TIMEOUT_MS"
  );
}
function resolveEngineIdleTimeoutMs(configuredTimeoutMs) {
  return resolvePositiveInteger(
    configuredTimeoutMs ?? process.env["MEMORIES_ENGINE_IDLE_TIMEOUT_MS"],
    DEFAULT_ENGINE_IDLE_TIMEOUT_MS,
    "MEMORIES_ENGINE_IDLE_TIMEOUT_MS"
  );
}
export {
  resolveEngineBootTimeoutMs,
  resolveEngineIdleTimeoutMs
};
