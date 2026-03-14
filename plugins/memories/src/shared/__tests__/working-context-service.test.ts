import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createDirectory,
  createDirectorySymlink,
  createTempDirectory,
  removePath,
} from "./helpers.js";
import { WorkingContextService } from "../services/working-context-service.js";

describe("WorkingContextService", () => {
  it("canonicalizes the selected path with realpath", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-working-context-");
    const actualDirectory = path.join(tempDirectory, "actual");
    const symlinkDirectory = path.join(tempDirectory, "linked");

    testContext.after(async () => {
      await removePath(tempDirectory);
    });

    await createDirectory(actualDirectory);
    await createDirectorySymlink(actualDirectory, symlinkDirectory);
    const canonicalActualDirectory = await realpath(actualDirectory);

    const workingContext = await WorkingContextService.resolveWorkingContext({
      projectRoot: symlinkDirectory,
      processCwd: "/unused/process-cwd",
    });

    assert.deepEqual(workingContext, {
      source: "project_root",
      selectedWorkingPath: symlinkDirectory,
      resolvedWorkingPath: canonicalActualDirectory,
    });
  });

  it("uses CLAUDE_PROJECT_DIR when explicit project inputs are absent", async (testContext) => {
    const tempDirectory = await createTempDirectory("claude-memory-working-context-env-");
    const canonicalTempDirectory = await realpath(tempDirectory);
    const originalClaudeProjectDir = process.env["CLAUDE_PROJECT_DIR"];

    testContext.after(async () => {
      await removePath(tempDirectory);
      if (originalClaudeProjectDir === undefined) {
        delete process.env["CLAUDE_PROJECT_DIR"];
        return;
      }

      process.env["CLAUDE_PROJECT_DIR"] = originalClaudeProjectDir;
    });

    process.env["CLAUDE_PROJECT_DIR"] = tempDirectory;

    const workingContext = await WorkingContextService.resolveWorkingContext({
      processCwd: "/unused/process-cwd",
    });

    assert.deepEqual(workingContext, {
      source: "claude_project_dir",
      selectedWorkingPath: tempDirectory,
      resolvedWorkingPath: canonicalTempDirectory,
    });
  });
});
