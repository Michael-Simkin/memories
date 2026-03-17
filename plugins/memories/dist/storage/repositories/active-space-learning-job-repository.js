import { ActiveMemorySpaceService } from "../../shared/services/active-memory-space-service.js";
import { LearningJobRepository } from "./learning-job-repository.js";
import { SpaceRegistryRepository } from "./space-registry-repository.js";
class ActiveSpaceLearningJobRepository {
  static toWorkingPathSelectionInput(context) {
    return {
      projectRoot: context.project_root,
      cwd: context.cwd
    };
  }
  static async resolveRequestedSpace(database, options) {
    if (options.spaceId) {
      const space = SpaceRegistryRepository.getSpaceById(database, options.spaceId);
      if (!space) {
        throw new Error(`Unable to find memory space "${options.spaceId}".`);
      }
      return {
        spaceId: space.id,
        rootPath: space.lastSeenRootPath
      };
    }
    if (!options.context) {
      throw new Error(
        "Active-space learning job enqueue requires either an explicit spaceId or a resolvable context."
      );
    }
    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace(
      ActiveSpaceLearningJobRepository.toWorkingPathSelectionInput(options.context)
    );
    const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(database, {
      resolution
    });
    return {
      spaceId: touchResult.space.id,
      rootPath: touchResult.root.rootPath
    };
  }
  static async enqueueLearningJob(database, input) {
    const resolvedSpace = await ActiveSpaceLearningJobRepository.resolveRequestedSpace(
      database,
      input
    );
    return LearningJobRepository.enqueueLearningJob(database, {
      id: input.id,
      spaceId: resolvedSpace.spaceId,
      rootPath: resolvedSpace.rootPath,
      transcriptPath: input.transcriptPath,
      lastAssistantMessage: input.lastAssistantMessage,
      sessionId: input.sessionId,
      enqueuedAt: input.enqueuedAt,
      updatedAt: input.updatedAt
    });
  }
}
export {
  ActiveSpaceLearningJobRepository
};
