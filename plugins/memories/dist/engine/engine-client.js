import { EngineHealthService } from "../shared/services/engine-health-service.js";
function createAbortSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}
function resolveEngineConnection(lock) {
  return {
    baseUrl: `http://${lock.host}:${String(lock.port)}`,
    host: lock.host,
    port: lock.port
  };
}
async function getEngineJson(connection, routePath, timeoutMs) {
  const response = await fetch(`${connection.baseUrl}${routePath}`, {
    signal: createAbortSignal(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(
      `Claude Memory engine request failed for "${routePath}" with status ${String(response.status)}.`
    );
  }
  return await response.json();
}
async function getEngineHealth(connection, timeoutMs) {
  return EngineHealthService.parseHealth(
    await getEngineJson(connection, "/health", timeoutMs)
  );
}
export {
  getEngineHealth,
  getEngineJson,
  resolveEngineConnection
};
