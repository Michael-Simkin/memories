import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { SqliteService } from "../sqlite-service.js";
import type {
  ListMemorySpacesOptions,
  PersistedMemorySpace,
  PersistedMemorySpaceSummary,
  PersistedSpaceRoot,
  TouchResolvedMemorySpaceInput,
  TouchMemorySpaceResult,
} from "../types/space-registry.js";

export class SpaceRegistryRepository {
  private static createStableId(prefix: string, value: string): string {
    return createHash("sha256").update(`${prefix}:${value}`, "utf8").digest("hex");
  }

  private static createSpaceId(spaceKey: string): string {
    return SpaceRegistryRepository.createStableId("space", spaceKey);
  }

  private static createSpaceRootId(spaceId: string, rootPath: string): string {
    return SpaceRegistryRepository.createStableId("space-root", `${spaceId}:${rootPath}`);
  }

  private static mapPersistedMemorySpace(row: unknown): PersistedMemorySpace {
    const persistedRow = row as {
      id: string;
      space_key: string;
      space_kind: PersistedMemorySpace["spaceKind"];
      display_name: string;
      last_seen_root_path: string;
      origin_url: string | null;
      origin_url_normalized: string | null;
      created_at: string;
      updated_at: string;
      last_seen_at: string;
    };

    return {
      id: persistedRow.id,
      spaceKey: persistedRow.space_key,
      spaceKind: persistedRow.space_kind,
      displayName: persistedRow.display_name,
      lastSeenRootPath: persistedRow.last_seen_root_path,
      originUrl: persistedRow.origin_url,
      originUrlNormalized: persistedRow.origin_url_normalized,
      createdAt: persistedRow.created_at,
      updatedAt: persistedRow.updated_at,
      lastSeenAt: persistedRow.last_seen_at,
    };
  }

  private static mapPersistedSpaceRoot(row: unknown): PersistedSpaceRoot {
    const persistedRow = row as {
      id: string;
      space_id: string;
      root_path: string;
      root_kind: PersistedSpaceRoot["rootKind"];
      first_seen_at: string;
      last_seen_at: string;
    };

    return {
      id: persistedRow.id,
      spaceId: persistedRow.space_id,
      rootPath: persistedRow.root_path,
      rootKind: persistedRow.root_kind,
      firstSeenAt: persistedRow.first_seen_at,
      lastSeenAt: persistedRow.last_seen_at,
    };
  }

  private static mapPersistedMemorySpaceSummary(
    row: unknown
  ): PersistedMemorySpaceSummary {
    const persistedRow = row as {
      created_at: string;
      display_name: string;
      id: string;
      last_seen_at: string;
      last_seen_root_path: string;
      memory_count: number;
      origin_url: string | null;
      origin_url_normalized: string | null;
      queued_job_count: number;
      root_count: number;
      running_job_count: number;
      space_key: string;
      space_kind: PersistedMemorySpace["spaceKind"];
      updated_at: string;
    };

    return {
      id: persistedRow.id,
      spaceKey: persistedRow.space_key,
      spaceKind: persistedRow.space_kind,
      displayName: persistedRow.display_name,
      lastSeenRootPath: persistedRow.last_seen_root_path,
      originUrl: persistedRow.origin_url,
      originUrlNormalized: persistedRow.origin_url_normalized,
      createdAt: persistedRow.created_at,
      updatedAt: persistedRow.updated_at,
      lastSeenAt: persistedRow.last_seen_at,
      rootCount: persistedRow.root_count,
      memoryCount: persistedRow.memory_count,
      queuedJobCount: persistedRow.queued_job_count,
      runningJobCount: persistedRow.running_job_count,
    };
  }

  private static normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return 100;
    }

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer.");
    }

    return limit;
  }

  private static readSpaceByKey(
    database: DatabaseSync,
    spaceKey: string,
  ): PersistedMemorySpace {
    const row = database
      .prepare(
        `SELECT
          id,
          space_key,
          space_kind,
          display_name,
          last_seen_root_path,
          origin_url,
          origin_url_normalized,
          created_at,
          updated_at,
          last_seen_at
        FROM memory_spaces
        WHERE space_key = ?`,
      )
      .get(spaceKey);

    if (!row) {
      throw new Error(`Unable to read persisted memory space for key "${spaceKey}".`);
    }

    return SpaceRegistryRepository.mapPersistedMemorySpace(row);
  }

  private static readSpaceById(
    database: DatabaseSync,
    spaceId: string,
  ): PersistedMemorySpace | null {
    const row = database
      .prepare(
        `SELECT
          id,
          space_key,
          space_kind,
          display_name,
          last_seen_root_path,
          origin_url,
          origin_url_normalized,
          created_at,
          updated_at,
          last_seen_at
        FROM memory_spaces
        WHERE id = ?`,
      )
      .get(spaceId);

    if (!row) {
      return null;
    }

    return SpaceRegistryRepository.mapPersistedMemorySpace(row);
  }

  private static readSpaceRoot(
    database: DatabaseSync,
    spaceId: string,
    rootPath: string,
  ): PersistedSpaceRoot {
    const row = database
      .prepare(
        `SELECT
          id,
          space_id,
          root_path,
          root_kind,
          first_seen_at,
          last_seen_at
        FROM space_roots
        WHERE space_id = ? AND root_path = ?`,
      )
      .get(spaceId, rootPath);

    if (!row) {
      throw new Error(
        `Unable to read persisted space root for space "${spaceId}" and root "${rootPath}".`,
      );
    }

    return SpaceRegistryRepository.mapPersistedSpaceRoot(row);
  }

  private static upsertSpace(
    database: DatabaseSync,
    input: TouchResolvedMemorySpaceInput,
  ): PersistedMemorySpace {
    const spaceId = SpaceRegistryRepository.createSpaceId(input.resolution.space.spaceKey);
    const observedAt = input.observedAt ?? new Date().toISOString();

    database
      .prepare(
        `INSERT INTO memory_spaces (
          id,
          space_key,
          space_kind,
          display_name,
          last_seen_root_path,
          origin_url,
          origin_url_normalized,
          created_at,
          updated_at,
          last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(space_key) DO UPDATE SET
          display_name = excluded.display_name,
          last_seen_root_path = excluded.last_seen_root_path,
          origin_url = excluded.origin_url,
          origin_url_normalized = excluded.origin_url_normalized,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        spaceId,
        input.resolution.space.spaceKey,
        input.resolution.space.spaceKind,
        input.resolution.space.displayName,
        input.resolution.space.rootPath,
        input.resolution.space.originUrl,
        input.resolution.space.originUrlNormalized,
        observedAt,
        observedAt,
        observedAt,
      );

    return SpaceRegistryRepository.readSpaceByKey(
      database,
      input.resolution.space.spaceKey,
    );
  }

  private static upsertSpaceRoot(
    database: DatabaseSync,
    spaceId: string,
    input: TouchResolvedMemorySpaceInput,
  ): PersistedSpaceRoot {
    const observedAt = input.observedAt ?? new Date().toISOString();
    const rootId = SpaceRegistryRepository.createSpaceRootId(
      spaceId,
      input.resolution.space.rootPath,
    );

    database
      .prepare(
        `INSERT INTO space_roots (
          id,
          space_id,
          root_path,
          root_kind,
          first_seen_at,
          last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(space_id, root_path) DO UPDATE SET
          root_kind = excluded.root_kind,
          last_seen_at = excluded.last_seen_at`,
      )
      .run(
        rootId,
        spaceId,
        input.resolution.space.rootPath,
        input.resolution.space.rootKind,
        observedAt,
        observedAt,
      );

    return SpaceRegistryRepository.readSpaceRoot(
      database,
      spaceId,
      input.resolution.space.rootPath,
    );
  }

  static touchResolvedMemorySpace(
    database: DatabaseSync,
    input: TouchResolvedMemorySpaceInput,
  ): TouchMemorySpaceResult {
    return SqliteService.transaction(database, () => {
      const space = SpaceRegistryRepository.upsertSpace(database, input);
      const root = SpaceRegistryRepository.upsertSpaceRoot(database, space.id, input);

      return {
        space,
        root,
      };
    });
  }

  static getSpaceById(
    database: DatabaseSync,
    spaceId: string,
  ): PersistedMemorySpace | null {
    return SpaceRegistryRepository.readSpaceById(database, spaceId);
  }

  static listSpaces(
    database: DatabaseSync,
    options: ListMemorySpacesOptions = {},
  ): PersistedMemorySpaceSummary[] {
    const limit = SpaceRegistryRepository.normalizeLimit(options.limit);
    const rows = database
      .prepare(
        `SELECT
          memory_spaces.id,
          memory_spaces.space_key,
          memory_spaces.space_kind,
          memory_spaces.display_name,
          memory_spaces.last_seen_root_path,
          memory_spaces.origin_url,
          memory_spaces.origin_url_normalized,
          memory_spaces.created_at,
          memory_spaces.updated_at,
          memory_spaces.last_seen_at,
          count(DISTINCT space_roots.id) AS root_count,
          count(DISTINCT memories.id) AS memory_count,
          count(DISTINCT CASE WHEN learning_jobs.state IN ('pending', 'leased') THEN learning_jobs.id END) AS queued_job_count,
          count(DISTINCT CASE WHEN learning_jobs.state = 'running' THEN learning_jobs.id END) AS running_job_count
        FROM memory_spaces
        LEFT JOIN space_roots ON space_roots.space_id = memory_spaces.id
        LEFT JOIN memories ON memories.space_id = memory_spaces.id
        LEFT JOIN learning_jobs ON learning_jobs.space_id = memory_spaces.id
        GROUP BY memory_spaces.id
        ORDER BY memory_spaces.last_seen_at DESC, memory_spaces.id ASC
        LIMIT ${String(limit)}`
      )
      .all();

    return rows.map((row) =>
      SpaceRegistryRepository.mapPersistedMemorySpaceSummary(row)
    );
  }
}
