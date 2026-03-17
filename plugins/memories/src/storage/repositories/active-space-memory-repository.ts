import type { DatabaseSync } from "node:sqlite";

import { ActiveMemorySpaceService } from "../../shared/services/active-memory-space-service.js";
import type { WorkingPathSelectionInput } from "../../shared/types/memory-space.js";
import type { CurrentContext } from "../../shared/types/space.js";
import { MemoryRetrievalRepository } from "./memory-retrieval-repository.js";
import { MemoryRepository } from "./memory-repository.js";
import { SpaceRegistryRepository } from "./space-registry-repository.js";
import type {
  CreateActiveMemoryInput,
  DeleteActiveMemoryOptions,
  ListActivePinnedMemoriesOptions,
  PersistedMemoryRecord,
  PersistedMemorySearchResponse,
  PersistedPinnedMemoriesResult,
  ResolveActiveSpaceOptions,
  SearchActiveMemoriesOptions,
  UpdateActiveMemoryInput,
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

  private static requireMemoryInSpace(
    database: DatabaseSync,
    memoryId: string,
    spaceId: string,
  ): PersistedMemoryRecord {
    const memory = MemoryRepository.getMemoryById(database, memoryId);

    if (!memory) {
      throw new Error(`Unable to find memory "${memoryId}".`);
    }

    if (memory.space_id !== spaceId) {
      throw new Error(
        `Memory "${memoryId}" does not belong to active space "${spaceId}".`,
      );
    }

    return memory;
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
      semanticEmbedding: input.semanticEmbedding,
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
      queryEmbedding: options.queryEmbedding,
      relatedPaths: options.relatedPaths,
      limit: options.limit,
    });
  }

  static async updateMemory(
    database: DatabaseSync,
    input: UpdateActiveMemoryInput,
  ): Promise<PersistedMemoryRecord> {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      input,
    );

    ActiveSpaceMemoryRepository.requireMemoryInSpace(
      database,
      input.memoryId,
      spaceId,
    );

    return MemoryRepository.updateMemory(database, {
      memoryId: input.memoryId,
      memoryType: input.memoryType,
      content: input.content,
      tags: input.tags,
      isPinned: input.isPinned,
      pathMatchers: input.pathMatchers,
      semanticEmbedding: input.semanticEmbedding,
      updatedAt: input.updatedAt,
    });
  }

  static async deleteMemory(
    database: DatabaseSync,
    input: DeleteActiveMemoryOptions,
  ): Promise<void> {
    const spaceId = await ActiveSpaceMemoryRepository.resolveRequestedSpaceId(
      database,
      input,
    );

    ActiveSpaceMemoryRepository.requireMemoryInSpace(
      database,
      input.memoryId,
      spaceId,
    );

    MemoryRepository.deleteMemory(database, {
      memoryId: input.memoryId,
    });
  }
}
