import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MemorySpaceService } from "../../shared/services/memory-space-service.js";
import type {
  ActiveMemorySpaceResolution,
  GitInspection,
} from "../../shared/types/memory-space.js";
import { DatabaseBootstrapRepository } from "../repositories/database-bootstrap-repository.js";
import { EventRepository } from "../repositories/event-repository.js";
import { SpaceRegistryRepository } from "../repositories/space-registry-repository.js";

function createResolution(
  resolvedWorkingPath: string,
  git: GitInspection,
): ActiveMemorySpaceResolution {
  return {
    workingContext: {
      source: "cwd",
      selectedWorkingPath: resolvedWorkingPath,
      resolvedWorkingPath,
    },
    git,
    space: MemorySpaceService.resolveMemorySpace({
      resolvedWorkingPath,
      git,
    }),
  };
}

function createSpace(databasePath = ":memory:") {
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    databasePath,
  });
  const observedAt = "2026-03-14T07:00:00.000Z";
  const touchResult = SpaceRegistryRepository.touchResolvedMemorySpace(
    bootstrapResult.database,
    {
      resolution: createResolution("/workspace/project", {
        insideWorkTree: false,
      }),
      observedAt,
    },
  );

  return {
    bootstrapResult,
    touchResult,
  };
}

describe("EventRepository", () => {
  it("records events and lists them newest-first with JSON data round-tripped", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      EventRepository.recordEvent(bootstrapResult.database, {
        at: "2026-03-14T07:10:00.000Z",
        spaceId: touchResult.space.id,
        rootPath: "/workspace/project",
        event: "Job enqueued",
        kind: "learning_job",
        status: "info",
        jobId: "job-123",
        data: {
          attempt_count: 0,
          source: "stop-hook",
        },
      });
      const secondEvent = EventRepository.recordEvent(bootstrapResult.database, {
        at: "2026-03-14T07:11:00.000Z",
        event: "Memory retrieved",
        kind: "retrieval",
        status: "success",
        detail: "  returned pinned rule  ",
      });
      const allEvents = EventRepository.listEvents(bootstrapResult.database, {
        limit: 10,
      });
      const learningJobEvents = EventRepository.listEvents(bootstrapResult.database, {
        kind: "learning_job",
      });

      assert.equal(secondEvent.detail, "returned pinned rule");
      assert.deepEqual(
        allEvents.map((eventRecord) => eventRecord.event),
        ["Memory retrieved", "Job enqueued"],
      );
      assert.deepEqual(learningJobEvents, [
        {
          id: learningJobEvents[0]?.id,
          at: "2026-03-14T07:10:00.000Z",
          space_id: touchResult.space.id,
          space_kind: "directory",
          space_display_name: "/workspace/project",
          origin_url_normalized: null,
          root_path: "/workspace/project",
          event: "Job enqueued",
          kind: "learning_job",
          status: "info",
          session_id: null,
          memory_id: null,
          job_id: "job-123",
          detail: null,
          data: {
            attempt_count: 0,
            source: "stop-hook",
          },
        },
      ]);
    } finally {
      bootstrapResult.database.close();
    }
  });

  it("sets space_id to null on existing events when the owning space is deleted", () => {
    const { bootstrapResult, touchResult } = createSpace();

    try {
      const createdEvent = EventRepository.recordEvent(bootstrapResult.database, {
        at: "2026-03-14T07:20:00.000Z",
        spaceId: touchResult.space.id,
        event: "Space opened",
        kind: "space",
        status: "info",
      });

      bootstrapResult.database
        .prepare("DELETE FROM memory_spaces WHERE id = ?")
        .run(touchResult.space.id);

      const persistedEvent = EventRepository.listEvents(bootstrapResult.database, {
        limit: 1,
      })[0];

      assert.ok(persistedEvent);
      assert.equal(createdEvent.space_id, touchResult.space.id);
      assert.equal(persistedEvent.space_id, null);
      assert.equal(persistedEvent.space_kind, null);
      assert.equal(persistedEvent.space_display_name, null);
      assert.equal(persistedEvent.origin_url_normalized, null);
      assert.equal(persistedEvent.event, "Space opened");
    } finally {
      bootstrapResult.database.close();
    }
  });
});
