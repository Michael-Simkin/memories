import { EngineHealthService } from "../shared/services/engine-health-service.js";
import type { EngineLock } from "../shared/types/engine.js";
import type { EngineHealth } from "../shared/types/health.js";

export const DEFAULT_ENGINE_REQUEST_TIMEOUT_MS = 5_000;

export interface EngineConnection {
  baseUrl: string;
  host: string;
  port: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export function resolveEngineConnection(lock: EngineLock): EngineConnection {
  return {
    baseUrl: `http://${lock.host}:${String(lock.port)}`,
    host: lock.host,
    port: lock.port,
  };
}

async function readEngineErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json();

    if (isRecord(payload) && typeof payload["error"] === "string") {
      return payload["error"];
    }
  } catch {
    // Fall back to the generic status message below.
  }

  return `status ${String(response.status)}`;
}

async function requestEngineJson<T>(
  connection: EngineConnection,
  routePath: string,
  options: {
    body?: unknown;
    method?: "GET" | "POST";
    timeoutMs: number;
  },
): Promise<T> {
  const requestInit: RequestInit = {
    method: options.method ?? "GET",
    signal: createAbortSignal(options.timeoutMs),
  };

  if (options.body !== undefined) {
    requestInit.headers = {
      "content-type": "application/json",
    };
    requestInit.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${connection.baseUrl}${routePath}`, requestInit);

  if (!response.ok) {
    const engineErrorMessage = await readEngineErrorMessage(response);

    throw new Error(
      `Claude Memory engine request failed for "${routePath}": ${engineErrorMessage}.`,
    );
  }

  return (await response.json()) as T;
}

export async function getEngineJson<T>(
  connection: EngineConnection,
  routePath: string,
  timeoutMs: number,
): Promise<T> {
  return requestEngineJson<T>(connection, routePath, {
    timeoutMs,
  });
}

export async function postEngineJson<T>(
  connection: EngineConnection,
  routePath: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  return requestEngineJson<T>(connection, routePath, {
    method: "POST",
    body,
    timeoutMs,
  });
}

export async function getEngineHealth(
  connection: EngineConnection,
  timeoutMs: number,
): Promise<EngineHealth> {
  return EngineHealthService.parseHealth(
    await getEngineJson<unknown>(connection, "/health", timeoutMs),
  );
}
