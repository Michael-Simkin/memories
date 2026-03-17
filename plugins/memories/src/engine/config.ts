const DEFAULT_ENGINE_BOOT_TIMEOUT_MS = 15_000;
const DEFAULT_ENGINE_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

function resolvePositiveInteger(
  value: number | string | undefined,
  defaultValue: number,
  envName: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const numericValue =
    typeof value === "number" ? value : Number.parseInt(value, 10);

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${envName} must be a positive integer.`);
  }

  return numericValue;
}

export function resolveEngineBootTimeoutMs(
  configuredTimeoutMs?: number,
): number {
  return resolvePositiveInteger(
    configuredTimeoutMs ?? process.env["MEMORIES_ENGINE_BOOT_TIMEOUT_MS"],
    DEFAULT_ENGINE_BOOT_TIMEOUT_MS,
    "MEMORIES_ENGINE_BOOT_TIMEOUT_MS",
  );
}

export function resolveEngineIdleTimeoutMs(
  configuredTimeoutMs?: number,
): number {
  return resolvePositiveInteger(
    configuredTimeoutMs ?? process.env["MEMORIES_ENGINE_IDLE_TIMEOUT_MS"],
    DEFAULT_ENGINE_IDLE_TIMEOUT_MS,
    "MEMORIES_ENGINE_IDLE_TIMEOUT_MS",
  );
}
