import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
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
  private static async createEnqueueKey(
    spaceId: string,
    transcriptPath: string,
    sessionId: string | null | undefined,
  ): Promise<string> {
    let resolvedTranscriptPath = path.resolve(transcriptPath);

    try {
      resolvedTranscriptPath = await realpath(transcriptPath);
    } catch {
      // Fall back to the normalized absolute path if the transcript disappears.
    }

    let transcriptSize: number | null = null;
    let transcriptModifiedAtMs: number | null = null;

    try {
      const transcriptStats = await stat(resolvedTranscriptPath);

      transcriptSize = transcriptStats.size;
      transcriptModifiedAtMs = Math.trunc(transcriptStats.mtimeMs);
    } catch {
      // Missing transcripts are still handled explicitly during execution.
    }

    return createHash("sha256")
      .update(
        JSON.stringify({
          spaceId,
          resolvedTranscriptPath,
          sessionId: sessionId ?? null,
          transcriptSize,
          transcriptModifiedAtMs,
        }),
      )
      .digest("hex");
  }

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
    const enqueueKey = await ActiveSpaceLearningJobRepository.createEnqueueKey(
      resolvedSpace.spaceId,
      input.transcriptPath,
      input.sessionId,
    );

    return LearningJobRepository.enqueueLearningJob(database, {
      id: input.id,
      spaceId: resolvedSpace.spaceId,
      rootPath: resolvedSpace.rootPath,
      transcriptPath: input.transcriptPath,
      enqueueKey,
      lastAssistantMessage: input.lastAssistantMessage,
      sessionId: input.sessionId,
      enqueuedAt: input.enqueuedAt,
      updatedAt: input.updatedAt,
    });
  }
}
