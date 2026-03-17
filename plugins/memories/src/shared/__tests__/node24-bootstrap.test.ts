import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createTempDirectory,
  removePath,
} from "./helpers.js";

const execFileAsync = promisify(execFile);
const pluginRootPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const bootstrapScriptPath = path.join(
  pluginRootPath,
  "bin",
  "run-with-node24.sh",
);

async function createRuntimeProbeScript(
  directoryPath: string,
  fileName: string,
): Promise<string> {
  const scriptPath = path.join(directoryPath, fileName);

  await writeFile(scriptPath, 'console.log(process.version);\n', "utf8");

  return scriptPath;
}

async function createFakeNodeBinary(directoryPath: string): Promise<string> {
  const fakeNodePath = path.join(directoryPath, "node");
  const scriptText = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "v22.10.0"
  exit 0
fi

echo "fake node should not execute runtime scripts" >&2
exit 99
`;

  await writeFile(fakeNodePath, scriptText, "utf8");
  await chmod(fakeNodePath, 0o755);

  return fakeNodePath;
}

describe("run-with-node24.sh", () => {
  it("uses the current node binary when the launcher runtime is already Node 24", async (testContext) => {
    const tempDirectory = await createTempDirectory(
      "claude-memory-node24-bootstrap-",
    );
    const runtimeProbeScriptPath = await createRuntimeProbeScript(
      tempDirectory,
      "print-version.mjs",
    );

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    const executionResult = await execFileAsync(
      bootstrapScriptPath,
      [runtimeProbeScriptPath],
      {
        encoding: "utf8",
      },
    );

    assert.match(executionResult.stdout.trim(), /^v24\./u);
  });

  it("uses CLAUDE_MEMORY_NODE24_BIN when the launcher runtime is not Node 24", async (testContext) => {
    const tempDirectory = await createTempDirectory(
      "claude-memory-node24-bootstrap-fallback-",
    );
    const runtimeProbeScriptPath = await createRuntimeProbeScript(
      tempDirectory,
      "print-version.mjs",
    );

    await createFakeNodeBinary(tempDirectory);

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    const executionResult = await execFileAsync(
      bootstrapScriptPath,
      [runtimeProbeScriptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempDirectory}:${process.env["PATH"] ?? ""}`,
          CLAUDE_MEMORY_NODE24_BIN: process.execPath,
        },
      },
    );

    assert.match(executionResult.stdout.trim(), /^v24\./u);
  });

  it("fails with an actionable error when the launcher runtime is not Node 24 and no bootstrap binary is configured", async (testContext) => {
    const tempDirectory = await createTempDirectory(
      "claude-memory-node24-bootstrap-missing-",
    );
    const runtimeProbeScriptPath = await createRuntimeProbeScript(
      tempDirectory,
      "print-version.mjs",
    );

    await createFakeNodeBinary(tempDirectory);

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    await assert.rejects(
      () =>
        execFileAsync(bootstrapScriptPath, [runtimeProbeScriptPath], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${tempDirectory}:${process.env["PATH"] ?? ""}`,
            CLAUDE_MEMORY_NODE24_BIN: "",
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /requires Node 24/u,
        );
        return true;
      },
    );
  });
});
