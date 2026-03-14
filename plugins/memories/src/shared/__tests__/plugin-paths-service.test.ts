import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { PluginPathsService } from "../services/plugin-paths-service.js";

describe("PluginPathsService", () => {
  it("resolves the vendored sqlite-vec path from an explicit plugin root", () => {
    const pluginPaths = PluginPathsService.resolvePluginPaths({
      pluginRoot: "/tmp/plugin-root",
    });

    assert.deepEqual(pluginPaths, {
      pluginRootPath: "/tmp/plugin-root",
      vendoredSqliteVecPath: path.join(
        "/tmp/plugin-root",
        "vendor",
        "sqlite-vec",
        "darwin-arm64",
        "vec0.dylib",
      ),
    });
  });

  it("uses CLAUDE_PLUGIN_ROOT when an explicit plugin root is absent", () => {
    const originalPluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];

    try {
      process.env["CLAUDE_PLUGIN_ROOT"] = "/tmp/claude-plugin-root";

      assert.equal(
        PluginPathsService.resolvePluginRoot(),
        "/tmp/claude-plugin-root",
      );
    } finally {
      if (originalPluginRoot === undefined) {
        delete process.env["CLAUDE_PLUGIN_ROOT"];
      } else {
        process.env["CLAUDE_PLUGIN_ROOT"] = originalPluginRoot;
      }
    }
  });

  it("throws when no plugin root is available", () => {
    const originalPluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];

    try {
      delete process.env["CLAUDE_PLUGIN_ROOT"];

      assert.throws(
        () => PluginPathsService.resolvePluginRoot(),
        /CLAUDE_PLUGIN_ROOT must be set/u,
      );
    } finally {
      if (originalPluginRoot === undefined) {
        delete process.env["CLAUDE_PLUGIN_ROOT"];
      } else {
        process.env["CLAUDE_PLUGIN_ROOT"] = originalPluginRoot;
      }
    }
  });

  it("rejects relative plugin roots so resolution never depends on process.cwd()", () => {
    assert.throws(
      () =>
        PluginPathsService.resolvePluginRoot({
          pluginRoot: "./relative-plugin-root",
        }),
      /must be an absolute path/u,
    );
  });
});
