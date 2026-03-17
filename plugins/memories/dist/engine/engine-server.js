import { createServer } from "node:http";
import { once } from "node:events";
import { CLAUDE_MEMORY_VERSION } from "../shared/constants/version.js";
import { EngineHealthService } from "../shared/services/engine-health-service.js";
import { EngineLockService } from "../shared/services/engine-lock-service.js";
import { RuntimeSupportService } from "../shared/services/runtime-support-service.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { SpaceRegistryRepository } from "../storage/repositories/space-registry-repository.js";
import { StorageStatsRepository } from "../storage/repositories/storage-stats-repository.js";
import { resolveEngineIdleTimeoutMs } from "./config.js";
function writeJsonResponse(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}
`);
}
function readRequestPath(request) {
  const requestUrl = request.url ?? "/";
  const parsedUrl = new URL(requestUrl, "http://127.0.0.1");
  return parsedUrl.pathname;
}
async function startEngineServer(options = {}) {
  RuntimeSupportService.assertSupportedRuntime();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const idleTimeoutMs = resolveEngineIdleTimeoutMs(options.idleTimeoutMs);
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    claudeMemoryHome: options.claudeMemoryHome,
    currentWorkingDirectory: options.currentWorkingDirectory,
    pluginRoot: options.pluginRoot
  });
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  let lastActivityAt = startedAt;
  let resolvedPort = 0;
  let isClosing = false;
  let closePromise = null;
  let closedResolver = null;
  const closed = new Promise((resolve) => {
    closedResolver = resolve;
  });
  const signalHandlers = [];
  const refreshEngineLock = async () => {
    if (resolvedPort === 0) {
      return;
    }
    await EngineLockService.writeEngineLock(
      {
        host,
        port: resolvedPort,
        pid: process.pid,
        started_at: startedAt,
        last_activity_at: lastActivityAt,
        version: CLAUDE_MEMORY_VERSION
      },
      {
        claudeMemoryHome: options.claudeMemoryHome,
        currentWorkingDirectory: options.currentWorkingDirectory
      }
    );
  };
  const touchActivity = async () => {
    lastActivityAt = (/* @__PURE__ */ new Date()).toISOString();
    await refreshEngineLock();
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "GET") {
          writeJsonResponse(response, 405, {
            error: "Method not allowed."
          });
          return;
        }
        const requestPath = readRequestPath(request);
        if (requestPath === "/health") {
          writeJsonResponse(
            response,
            200,
            EngineHealthService.createExpectedHealth(
              DatabaseBootstrapRepository.getLatestSchemaVersion()
            )
          );
          return;
        }
        if (requestPath === "/stats") {
          await touchActivity();
          writeJsonResponse(response, 200, {
            ...StorageStatsRepository.getStats(bootstrapResult.database),
            idle_timeout_ms: idleTimeoutMs,
            last_activity_at: lastActivityAt,
            online: true,
            started_at: startedAt,
            uptime_ms: Date.now() - Date.parse(startedAt)
          });
          return;
        }
        if (requestPath === "/spaces") {
          await touchActivity();
          writeJsonResponse(response, 200, {
            spaces: SpaceRegistryRepository.listSpaces(bootstrapResult.database)
          });
          return;
        }
        writeJsonResponse(response, 404, {
          error: `Unknown route "${requestPath}".`
        });
      } catch (error) {
        writeJsonResponse(response, 500, {
          error: error instanceof Error ? error.message : "Unknown engine error."
        });
      }
    })();
  });
  const close = async () => {
    if (closePromise) {
      return closePromise;
    }
    closePromise = (async () => {
      if (isClosing) {
        return;
      }
      isClosing = true;
      clearInterval(idleInterval);
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      bootstrapResult.database.close();
      await EngineLockService.clearEngineLockIfOwned(process.pid, {
        claudeMemoryHome: options.claudeMemoryHome,
        currentWorkingDirectory: options.currentWorkingDirectory
      });
      closedResolver?.();
    })();
    return closePromise;
  };
  const idleInterval = setInterval(() => {
    void (async () => {
      if (isClosing) {
        return;
      }
      const idleForMs = Date.now() - Date.parse(lastActivityAt);
      const hasRunningJob = StorageStatsRepository.getStats(
        bootstrapResult.database
      ).runningJobs > 0;
      if (idleForMs < idleTimeoutMs || hasRunningJob) {
        return;
      }
      await close();
    })();
  }, Math.min(Math.max(250, Math.floor(idleTimeoutMs / 4)), 5e3));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Claude Memory engine did not bind to a TCP port.");
  }
  resolvedPort = address.port;
  await refreshEngineLock();
  if (options.registerSignalHandlers === true) {
    const handleSignal = () => {
      void close();
    };
    signalHandlers.push(["SIGINT", handleSignal], ["SIGTERM", handleSignal]);
    for (const [signal, handler] of signalHandlers) {
      process.on(signal, handler);
    }
  }
  return {
    close,
    closed,
    host,
    idleTimeoutMs,
    port: resolvedPort,
    startedAt
  };
}
export {
  startEngineServer
};
