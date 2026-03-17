import { startEngineServer } from "./engine-server.js";

async function main(): Promise<void> {
  try {
    await startEngineServer({
      claudeMemoryHome: process.env["CLAUDE_MEMORY_HOME"],
      currentWorkingDirectory: process.cwd(),
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
