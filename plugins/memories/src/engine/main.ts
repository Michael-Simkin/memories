import { startEngineServer } from "./engine-server.js";

function readOptionalPositiveIntegerEnv(envName: string): number | undefined {
  const rawValue = process.env[envName];

  if (rawValue === undefined) {
    return undefined;
  }

  const numericValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${envName} must be a positive integer.`);
  }

  return numericValue;
}

async function main(): Promise<void> {
  try {
    await startEngineServer({
      claudeMemoryHome: process.env["CLAUDE_MEMORY_HOME"],
      currentWorkingDirectory: process.cwd(),
      learningWorkerEnabled:
        process.env["MEMORIES_LEARNING_WORKER_DISABLED"] === "1"
          ? false
          : undefined,
      learningWorkerHeartbeatIntervalMs: readOptionalPositiveIntegerEnv(
        "MEMORIES_LEARNING_WORKER_HEARTBEAT_INTERVAL_MS",
      ),
      learningWorkerLeaseDurationMs: readOptionalPositiveIntegerEnv(
        "MEMORIES_LEARNING_WORKER_LEASE_DURATION_MS",
      ),
      learningWorkerPollIntervalMs: readOptionalPositiveIntegerEnv(
        "MEMORIES_LEARNING_WORKER_POLL_INTERVAL_MS",
      ),
      pluginRoot: process.env["CLAUDE_PLUGIN_ROOT"],
      registerSignalHandlers: true,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown engine startup error.";

    process.stderr.write(`${errorMessage}\n`);
    process.exitCode = 1;
  }
}

void main();
