import { ActiveMemorySpaceService } from "../../shared/services/active-memory-space-service.js";
import { MemoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { SpaceRegistryRepository } from "./space-registry-repository.js";
class ActiveSpaceMemoryRepository {
  static toWorkingPathSelectionInput(context) {
    return {
      projectRoot: context.project_root,
      cwd: context.cwd
    };
  }
  static async resolveRequestedSpaceId(database, options) {
    if (options.spaceId) {
      return options.spaceId;
    }
    if (!options.context) {
      throw new Error(
        "Active-space memory access requires either an explicit spaceId or a resolvable context."
      );
    }
    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace(
      ActiveSpaceMemoryRepository.toWorkingPathSelectionInput(options.context)
    );
    const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(database, {
      resolution
    });
    return touchResult.space.id;
  }
  static requireMemoryInSpace(database, memoryId, spaceId) {
    const memory = MemoryRepository.getMemoryById(database, memoryId);
    if (!memory) {
      throw new Error(`Unable to find memory "${memoryId}".`);
    }
    if (memory.space_id !== spaceId) {
      throw new Error(
        `Memory "${memoryId}" does not belong to active space "${spaceId}".`
      );
    }
    return memory;
  }
  static async createMemory(database, input) {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      input
    );
    return MemoryRepository.createMemory(database, {
      id: input.id,
      spaceId,
      memoryType: input.memoryType,
      content: input.content,
      tags: input.tags,
      isPinned: input.isPinned,
      pathMatchers: input.pathMatchers,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    });
  }
  static async listPinnedMemories(database, options) {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      options
    );
    return MemoryRepository.listPinnedMemories(database, {
      spaceId
    });
  }
  static async searchMemories(database, options) {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      options
    );
    return MemoryRetrievalRepository.searchMemories(database, {
      spaceId,
      query: options.query,
      relatedPaths: options.relatedPaths,
      limit: options.limit
    });
  }
  static async updateMemory(database, input) {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      input
    );
    ActiveSpaceMemoryRepository.requireMemoryInSpace(
      database,
      input.memoryId,
      spaceId
    );
    return MemoryRepository.updateMemory(database, {
      memoryId: input.memoryId,
      content: input.content,
      tags: input.tags,
      isPinned: input.isPinned,
      pathMatchers: input.pathMatchers,
      updatedAt: input.updatedAt
    });
  }
  static async deleteMemory(database, input) {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      input
    );
    ActiveSpaceMemoryRepository.requireMemoryInSpace(
      database,
      input.memoryId,
      spaceId
    );
    MemoryRepository.deleteMemory(database, {
      memoryId: input.memoryId
    });
  }
}
export {
  ActiveSpaceMemoryRepository
};
