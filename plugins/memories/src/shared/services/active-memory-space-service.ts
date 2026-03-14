import { GitInspectionService } from "./git-inspection-service.js";
import { MemorySpaceService } from "./memory-space-service.js";
import { WorkingContextService } from "./working-context-service.js";
import type {
  ActiveMemorySpaceResolution,
  WorkingPathSelectionInput,
} from "../types/memory-space.js";

export class ActiveMemorySpaceService {
  static async resolveActiveMemorySpace(
    input: WorkingPathSelectionInput = {},
  ): Promise<ActiveMemorySpaceResolution> {
    const workingContext = await WorkingContextService.resolveWorkingContext(input);
    const git = await GitInspectionService.inspectGitContext(
      workingContext.resolvedWorkingPath,
    );
    const space = MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath: workingContext.resolvedWorkingPath,
      git,
    });

    return {
      workingContext,
      git,
      space,
    };
  }
}
