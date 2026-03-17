import type { DatabaseSync } from "node:sqlite";

import { ActiveMemorySpaceService } from "../../shared/services/active-memory-space-service.js";
import type { WorkingPathSelectionInput } from "../../shared/types/memory-space.js";
import type { CurrentContext } from "../../shared/types/space.js";
import { LearningJobRepository } from "./learning-job-repository.js";
import { SpaceRegistryRepository } from "./space-registry-repository.js";
import type {
  EnqueueActiveLearningJobInput,
  PersistedLearningJob,
  ResolveActiveLearningSpaceOptions,
} from "../types/learning-job.js";

interface ResolvedLearningJobSpace {
  rootPath: string;
  spaceId: string;
}

export class ActiveSpaceLearningJobRepository {
  private static toWorkingPathSelectionInput(
    context: CurrentContext,
  ): WorkingPathSelectionInput {
    return {
      projectRoot: context.project_root,
      cwd: context.cwd,
    };
  }

  private static async resolveRequestedSpace(
    database: DatabaseSync,
    options: ResolveActiveLearningSpaceOptions,
  ): Promise<ResolvedLearningJobSpace> {
    if (options.spaceId) {
      const space = SpaceRegistryRepository.getSpaceById(database, options.spaceId);

      if (!space) {
        throw new Error(`Unable to find memory space "${options.spaceId}".`);
      }

      return {
        spaceId: space.id,
        rootPath: space.lastSeenRootPath,
      };
    }

    if (!options.context) {
      throw new Error(
        "Active-space learning job enqueue requires either an explicit spaceId or a resolvable context.",
      );
    }

    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace(
      ActiveSpaceLearningJobRepository.toWorkingPathSelectionInput(options.context),
    );
    const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(database, {
      resolution,
    });

    return {
      spaceId: touchResult.space.id,
      rootPath: touchResult.root.rootPath,
    };
  }

  static async enqueueLearningJob(
    database: DatabaseSync,
    input: EnqueueActiveLearningJobInput,
  ): Promise<PersistedLearningJob> {
    const resolvedSpace = await ActiveSpaceLearningJobRepository.resolveRequestedSpace(
      database,
      input,
    );

    return LearningJobRepository.enqueueLearningJob(database, {
      id: input.id,
      spaceId: resolvedSpace.spaceId,
      rootPath: resolvedSpace.rootPath,
      transcriptPath: input.transcriptPath,
      lastAssistantMessage: input.lastAssistantMessage,
      sessionId: input.sessionId,
      enqueuedAt: input.enqueuedAt,
      updatedAt: input.updatedAt,
    });
  }
}
