import type { DatabaseSync } from "node:sqlite";

import { ActiveMemorySpaceService } from "../../shared/services/active-memory-space-service.js";
import type { WorkingPathSelectionInput } from "../../shared/types/memory-space.js";
import type { CurrentContext } from "../../shared/types/space.js";
import { MemoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { SpaceRegistryRepository } from "./space-registry-repository.js";
import type {
  CreateActiveMemoryInput,
  ListActivePinnedMemoriesOptions,
  PersistedMemoryRecord,
  PersistedMemorySearchResponse,
  PersistedPinnedMemoriesResult,
  ResolveActiveSpaceOptions,
  SearchActiveMemoriesOptions,
} from "../types/memory.js";

export class ActiveSpaceMemoryRepository {
  private static toWorkingPathSelectionInput(
    context: CurrentContext,
  ): WorkingPathSelectionInput {
    return {
      projectRoot: context.project_root,
      cwd: context.cwd,
    };
  }

  private static async resolveRequestedSpaceId(
    database: DatabaseSync,
    options: ResolveActiveSpaceOptions,
  ): Promise<string> {
    if (options.spaceId) {
      return options.spaceId;
    }

    if (!options.context) {
      throw new Error(
        "Active-space memory access requires either an explicit spaceId or a resolvable context.",
      );
    }

    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace(
      ActiveSpaceMemoryRepository.toWorkingPathSelectionInput(options.context),
    );
    const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(database, {
      resolution,
    });

    return touchResult.space.id;
  }

  static async createMemory(
    database: DatabaseSync,
    input: CreateActiveMemoryInput,
  ): Promise<PersistedMemoryRecord> {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      input,
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
      updatedAt: input.updatedAt,
    });
  }

  static async listPinnedMemories(
    database: DatabaseSync,
    options: ListActivePinnedMemoriesOptions,
  ): Promise<PersistedPinnedMemoriesResult> {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      options,
    );

    return MemoryRepository.listPinnedMemories(database, {
      spaceId,
    });
  }

  static async searchMemories(
    database: DatabaseSync,
    options: SearchActiveMemoriesOptions,
  ): Promise<PersistedMemorySearchResponse> {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      options,
    );

    return MemoryRetrievalRepository.searchMemories(database, {
      spaceId,
      query: options.query,
      relatedPaths: options.relatedPaths,
      limit: options.limit,
    });
  }
}
