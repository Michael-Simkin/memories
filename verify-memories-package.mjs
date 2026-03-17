import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRootPath = path.dirname(fileURLToPath(import.meta.url));
const pluginWorkspaceName = "@claude-memory/memories";
const marketplaceManifestPath = path.join(
  repoRootPath,
  ".claude-plugin",
  "marketplace.json",
);
const mcpConfigPath = path.join(
  repoRootPath,
  "plugins",
  "memories",
  ".mcp.json",
);
const hooksConfigPath = path.join(
  repoRootPath,
  "plugins",
  "memories",
  "hooks",
  "hooks.json",
);
const pluginManifestPath = path.join(
  repoRootPath,
  "plugins",
  "memories",
  ".claude-plugin",
  "plugin.json",
);

const requiredPackPaths = [
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "bin/run-with-node24.sh",
  "dist/engine/main.js",
  "dist/hooks/hook-runtime.js",
  "dist/hooks/session-start.js",
  "dist/hooks/stop.js",
  "dist/hooks/user-prompt-submit.js",
  "dist/mcp/search-server.js",
  "dist/shared/services/plugin-paths-service.js",
  "dist/storage/sqlite-service.js",
  "dist/storage/sqlite-vec-service.js",
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
  if (filePath.startsWith("src/")) {
    return true;
  }

  if (filePath.includes("/__tests__/")) {
    return true;
  }

  return (
    filePath.endsWith(".ts") ||
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
    "./hooks/hooks.json",
    'Plugin manifest must wire hooks from "./hooks/hooks.json".',
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
    "--dry-run",
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

  const packFiles = packResult.files;

  assert.ok(Array.isArray(packFiles), "Packed workspace result is missing its file list.");

  const packedPaths = packFiles
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

  console.log(
    "Verified marketplace and plugin manifests plus the memories package boundary, dist artifacts, and vendored sqlite-vec packaging.",
  );
}

main().catch((error) => {
  const errorText =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  console.error(errorText);
  process.exitCode = 1;
});
