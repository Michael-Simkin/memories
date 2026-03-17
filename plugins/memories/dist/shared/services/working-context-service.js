import { realpath } from "node:fs/promises";
import { MemorySpaceService } from "./memory-space-service.js";
class WorkingContextService {
  static async resolveWorkingContext(input = {}) {
    const selectedWorkingPath = MemorySpaceService.selectWorkingPath({
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      claudeProjectDir: input.claudeProjectDir ?? process.env["CLAUDE_PROJECT_DIR"],
      processCwd: input.processCwd ?? process.cwd()
    });
    const resolvedWorkingPath = await realpath(selectedWorkingPath.workingPath);
    return {
      source: selectedWorkingPath.source,
      selectedWorkingPath: selectedWorkingPath.workingPath,
      resolvedWorkingPath
    };
  }
}
export {
  WorkingContextService
};
