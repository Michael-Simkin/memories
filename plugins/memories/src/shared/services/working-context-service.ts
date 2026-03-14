import { realpath } from "node:fs/promises";

import { MemorySpaceService } from "./memory-space-service.js";
import type {
  ResolvedWorkingContext,
  WorkingPathSelectionInput,
} from "../types/memory-space.js";

export class WorkingContextService {
  static async resolveWorkingContext(
    input: WorkingPathSelectionInput = {},
  ): Promise<ResolvedWorkingContext> {
    const selectedWorkingPath = MemorySpaceService.selectWorkingPath({
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      claudeProjectDir: input.claudeProjectDir ?? process.env["CLAUDE_PROJECT_DIR"],
      processCwd: input.processCwd ?? process.cwd(),
    });
    const resolvedWorkingPath = await realpath(selectedWorkingPath.workingPath);

    return {
      source: selectedWorkingPath.source,
      selectedWorkingPath: selectedWorkingPath.workingPath,
      resolvedWorkingPath,
    };
  }
}
