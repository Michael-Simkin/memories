import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRootPath = path.dirname(fileURLToPath(import.meta.url));
const pluginWorkspaceName = "@claude-memory/memories";
const pluginRootPath = path.join(repoRootPath, "plugins", "memories");
const marketplaceManifestPath = path.join(
  repoRootPath,
  ".claude-plugin",
  "marketplace.json",
);
const mcpConfigPath = path.join(pluginRootPath, ".mcp.json");
const hooksConfigPath = path.join(pluginRootPath, "hooks", "hooks.json");
const pluginManifestPath = path.join(
  pluginRootPath,
  ".claude-plugin",
  "plugin.json",
);

const requiredPackPaths = [
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "bin/run-with-node24.sh",
  "dist/engine/main.js",
  "dist/hooks/session-start.js",
  "dist/hooks/stop.js",
  "dist/hooks/user-prompt-submit.js",
  "dist/mcp/search-server.js",
  "dist/ui/index.html",
  "hooks/hooks.json",
  "package.json",
  "vendor/sqlite-vec/darwin-arm64/vec0.dylib",
];

const allowedPackPathPrefixes = [
  ".claude-plugin/",
  "bin/",
  "dist/",
  "hooks/",
  "vendor/",
];

const allowedExactPackPaths = new Set([".mcp.json", "package.json"]);

function isAllowedPackPath(filePath) {
  if (allowedExactPackPaths.has(filePath)) {
    return true;
  }

  return allowedPackPathPrefixes.some((prefix) => filePath.startsWith(prefix));
}

function isLeakedSourcePath(filePath) {
  if (filePath.startsWith("src/") || filePath.startsWith("web/")) {
    return true;
  }

  if (filePath.includes("/__tests__/")) {
    return true;
  }

  return (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath === "tsconfig.json" ||
    filePath === "tsup.config.ts"
  );
}

async function runNpmCommand(args) {
  return execFileAsync("npm", args, {
    cwd: repoRootPath,
    encoding: "utf8",
  });
}

async function readJsonFile(jsonFilePath) {
  const fileText = await readFile(jsonFilePath, "utf8");
  return JSON.parse(fileText);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, options) {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const result = await predicate();

    if (result !== null) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }

  throw new Error(options.errorMessage);
}

async function stopChildProcess(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error("Timed out waiting for child process shutdown."));
        }, 5_000),
      ),
    ]);
  } catch {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function smokeTestPackedEngine(packageRoot) {
  const claudeMemoryHome = await mkdtemp(
    path.join(tmpdir(), "claude-memory-packaged-engine-"),
  );
  const engineEntrypointPath = path.join(packageRoot, "dist", "engine", "main.js");
  let stderrText = "";
  const child = spawn(process.execPath, [engineEntrypointPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      CLAUDE_MEMORY_HOME: claudeMemoryHome,
      CLAUDE_PLUGIN_ROOT: packageRoot,
      MEMORIES_LEARNING_WORKER_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  try {
    const engineLockPath = path.join(claudeMemoryHome, "engine.lock.json");
    const engineLock = await waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(
            `Packaged engine exited before becoming healthy.${stderrText ? `\n${stderrText.trim()}` : ""}`,
          );
        }

        if (!(await pathExists(engineLockPath))) {
          return null;
        }

        return readJsonFile(engineLockPath);
      },
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        errorMessage: "Timed out waiting for the packaged engine lock file.",
      },
    );
    const baseUrl = `http://${engineLock.host}:${String(engineLock.port)}`;
    const healthResponse = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const statsResponse = await fetch(`${baseUrl}/stats`, {
      signal: AbortSignal.timeout(5_000),
    });
    const spacesResponse = await fetch(`${baseUrl}/spaces`, {
      signal: AbortSignal.timeout(5_000),
    });
    const uiResponse = await fetch(`${baseUrl}/ui`, {
      signal: AbortSignal.timeout(5_000),
    });
    const healthPayload = await healthResponse.json();
    const statsText = await statsResponse.text();
    const spacesText = await spacesResponse.text();
    const uiHtml = await uiResponse.text();

    assert.equal(healthResponse.status, 200, "Packaged engine /health must respond.");
    assert.equal(
      healthPayload.db_schema_version,
      6,
      "Packaged engine must expose the current database schema version.",
    );
    assert.equal(
      statsResponse.status,
      200,
      `Packaged engine /stats must respond. Response body: ${statsText}`,
    );
    const statsPayload = JSON.parse(statsText);
    assert.equal(statsPayload.online, true, "Packaged engine must report online.");
    assert.equal(
      spacesResponse.status,
      200,
      `Packaged engine /spaces must respond. Response body: ${spacesText}`,
    );
    const spacesPayload = JSON.parse(spacesText);
    assert.ok(Array.isArray(spacesPayload.spaces), "Packaged engine /spaces must return an array.");
    assert.equal(uiResponse.status, 200, "Packaged engine /ui must respond.");
    assert.match(uiHtml, /<title>Claude Memory UI<\/title>/u);
  } finally {
    await stopChildProcess(child);
    await rm(claudeMemoryHome, { recursive: true, force: true });
  }
}

async function main() {
  const marketplaceManifest = await readJsonFile(marketplaceManifestPath);
  const mcpConfig = await readJsonFile(mcpConfigPath);
  const hooksConfig = await readJsonFile(hooksConfigPath);
  const pluginManifest = await readJsonFile(pluginManifestPath);

  assert.equal(
    marketplaceManifest.name,
    "claude-memory",
    "Marketplace manifest must declare the claude-memory marketplace name.",
  );
  assert.ok(
    Array.isArray(marketplaceManifest.plugins),
    "Marketplace manifest must include a plugins array.",
  );
  assert.deepEqual(
    marketplaceManifest.plugins,
    [
      {
        name: "memories",
        source: "./plugins/memories",
        description:
          "Local memory for Claude Code with remote-repo and directory-scoped memory spaces.",
        version: "0.0.0",
      },
    ],
    "Marketplace manifest must publish exactly one local memories plugin entry.",
  );

  assert.equal(
    pluginManifest.name,
    "memories",
    "Plugin manifest must declare the memories plugin name.",
  );
  assert.equal(
    pluginManifest.version,
    "0.0.0",
    "Plugin manifest must carry the current plugin version.",
  );
  assert.equal(
    pluginManifest.hooks,
    undefined,
    "Plugin manifest must not explicitly wire the standard hooks/hooks.json because Claude loads it automatically.",
  );
  assert.equal(
    pluginManifest.mcpServers,
    "./.mcp.json",
    'Plugin manifest must wire MCP servers from "./.mcp.json".',
  );

  assert.deepEqual(
    mcpConfig,
    {
      mcpServers: {
        memories: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/run-with-node24.sh",
          args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/search-server.js"],
        },
      },
    },
    "MCP config must register exactly one memories stdio server through the Node 24 wrapper.",
  );

  assert.deepEqual(
    hooksConfig,
    {
      description: "Claude Memory lifecycle hooks",
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "\"${CLAUDE_PLUGIN_ROOT}/bin/run-with-node24.sh\" \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/session-start.js\"",
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "\"${CLAUDE_PLUGIN_ROOT}/bin/run-with-node24.sh\" \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/user-prompt-submit.js\"",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "\"${CLAUDE_PLUGIN_ROOT}/bin/run-with-node24.sh\" \"${CLAUDE_PLUGIN_ROOT}/dist/hooks/stop.js\"",
              },
            ],
          },
        ],
      },
    },
    "Hook config must wire SessionStart, UserPromptSubmit, and Stop through the Node 24 wrapper.",
  );

  await runNpmCommand(["run", "build", "--workspace", pluginWorkspaceName]);

  const packCommandResult = await runNpmCommand([
    "pack",
    "--json",
    "--workspace",
    pluginWorkspaceName,
  ]);
  const packResults = JSON.parse(packCommandResult.stdout);

  assert.ok(Array.isArray(packResults), "npm pack did not return a JSON array.");
  assert.equal(
    packResults.length,
    1,
    "Expected exactly one packed workspace result for the memories plugin.",
  );

  const [packResult] = packResults;

  assert.ok(
    packResult && typeof packResult === "object",
    "npm pack returned an unexpected result payload.",
  );
  assert.ok(Array.isArray(packResult.files), "Packed workspace result is missing its file list.");
  assert.equal(
    typeof packResult.filename,
    "string",
    "Packed workspace result must include a filename.",
  );

  const packedPaths = packResult.files
    .map((fileEntry) => {
      if (!fileEntry || typeof fileEntry !== "object") {
        throw new Error("Packed workspace file entry has an unexpected shape.");
      }

      const filePath = fileEntry.path;

      if (typeof filePath !== "string") {
        throw new Error("Packed workspace file entry is missing a string path.");
      }

      return filePath;
    })
    .sort();

  for (const requiredPackPath of requiredPackPaths) {
    assert.ok(
      packedPaths.includes(requiredPackPath),
      `Expected packed plugin to include "${requiredPackPath}".`,
    );
  }

  const unexpectedPackPaths = packedPaths.filter(
    (filePath) => !isAllowedPackPath(filePath),
  );

  assert.deepEqual(
    unexpectedPackPaths,
    [],
    `Packed plugin included files outside the allowed published boundary: ${unexpectedPackPaths.join(", ")}`,
  );

  const leakedSourcePaths = packedPaths.filter((filePath) =>
    isLeakedSourcePath(filePath),
  );

  assert.deepEqual(
    leakedSourcePaths,
    [],
    `Packed plugin leaked raw source or test files: ${leakedSourcePaths.join(", ")}`,
  );

  const nodeModulesPaths = packedPaths.filter((filePath) =>
    filePath.startsWith("node_modules/"),
  );

  assert.deepEqual(
    nodeModulesPaths,
    [],
    `Packed plugin must not rely on plugin-local node_modules: ${nodeModulesPaths.join(", ")}`,
  );

  const tarballPath = path.join(repoRootPath, packResult.filename);
  const extractDirectoryPath = await mkdtemp(
    path.join(tmpdir(), "claude-memory-packaged-plugin-"),
  );

  try {
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractDirectoryPath], {
      cwd: repoRootPath,
    });

    const extractedPackagePath = path.join(extractDirectoryPath, "package");

    assert.equal(
      await pathExists(path.join(extractedPackagePath, "node_modules")),
      false,
      "Extracted packaged plugin must not include node_modules.",
    );

    await smokeTestPackedEngine(extractedPackagePath);
  } finally {
    await unlink(tarballPath).catch(() => {});
    await rm(extractDirectoryPath, { recursive: true, force: true });
  }

  console.log(
    "Verified manifests, packaged file boundary, vendored sqlite-vec, and a cold-start smoke test from the packed plugin artifact.",
  );
}

main().catch((error) => {
  const errorText =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  console.error(errorText);
  process.exitCode = 1;
});
