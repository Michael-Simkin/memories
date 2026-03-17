import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  normalizeNonEmptyString,
  normalizeNullableString,
} from "../../shared/utils/strings.js";
import { SqliteService } from "../sqlite-service.js";
import type {
  EnqueueLearningJobInput,
  FinalizeLearningJobInput,
  HeartbeatLearningJobInput,
  LeaseLearningJobInput,
  ListLearningJobsOptions,
  PersistedLearningJob,
  StartLearningJobInput,
  UpdateLearningJobInput,
} from "../types/learning-job.js";

interface LearningJobRow {
  id: string;
  space_id: string;
  space_kind: PersistedLearningJob["space_kind"];
  space_display_name: PersistedLearningJob["space_display_name"];
  origin_url_normalized: PersistedLearningJob["origin_url_normalized"];
  root_path: string;
  transcript_path: string;
  enqueue_key: string | null;
  last_assistant_message: string | null;
  session_id: string | null;
  state: PersistedLearningJob["state"];
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  error_text: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export class LearningJobRepository {
  private static hydrateLearningJobRow(row: Record<string, unknown>): LearningJobRow {
    return {
      id: row["id"] as string,
      space_id: row["space_id"] as string,
      space_kind: row["space_kind"] as PersistedLearningJob["space_kind"],
      space_display_name: row["space_display_name"] as PersistedLearningJob["space_display_name"],
      origin_url_normalized: row["origin_url_normalized"] as PersistedLearningJob["origin_url_normalized"],
      root_path: row["root_path"] as string,
      transcript_path: row["transcript_path"] as string,
      enqueue_key: row["enqueue_key"] as string | null,
      last_assistant_message: row["last_assistant_message"] as string | null,
      session_id: row["session_id"] as string | null,
      state: row["state"] as PersistedLearningJob["state"],
      lease_owner: row["lease_owner"] as string | null,
      lease_expires_at: row["lease_expires_at"] as string | null,
      attempt_count: row["attempt_count"] as number,
      error_text: row["error_text"] as string | null,
      enqueued_at: row["enqueued_at"] as string,
      started_at: row["started_at"] as string | null,
      finished_at: row["finished_at"] as string | null,
      updated_at: row["updated_at"] as string,
    };
  }

  private static mapLearningJobRow(row: LearningJobRow): PersistedLearningJob {
    return {
      id: row.id,
      space_id: row.space_id,
      space_kind: row.space_kind,
      space_display_name: row.space_display_name,
      origin_url_normalized: row.origin_url_normalized,
      root_path: row.root_path,
      transcript_path: row.transcript_path,
      last_assistant_message: row.last_assistant_message,
      session_id: row.session_id,
      state: row.state,
      lease_owner: row.lease_owner,
      lease_expires_at: row.lease_expires_at,
      attempt_count: row.attempt_count,
      error_text: row.error_text,
      enqueued_at: row.enqueued_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      updated_at: row.updated_at,
    };
  }

  private static normalizeRequiredText(value: string, fieldName: string): string {
    const normalizedValue = normalizeNonEmptyString(value);

    if (!normalizedValue) {
      throw new Error(`${fieldName} must be a non-empty string.`);
    }

    return normalizedValue;
  }

  private static normalizeNullableText(value: string | null | undefined): string | null {
    return normalizeNullableString(value);
  }

  private static normalizeEnqueueKey(enqueueKey: string | undefined): string | null {
    return normalizeNonEmptyString(enqueueKey) ?? null;
  }

  private static normalizeAttemptCount(attemptCount: number): number {
    if (!Number.isInteger(attemptCount) || attemptCount < 0) {
      throw new Error("attemptCount must be a non-negative integer.");
    }

    return attemptCount;
  }

  private static normalizeLeaseDurationMs(leaseDurationMs: number): number {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("leaseDurationMs must be a positive integer.");
    }

    return leaseDurationMs;
  }

  private static normalizeTimestamp(value: string | undefined, fieldName: string): string {
    const timestamp = value ?? new Date().toISOString();

    if (Number.isNaN(Date.parse(timestamp))) {
      throw new Error(`${fieldName} must be a valid ISO timestamp.`);
    }

    return timestamp;
  }

  private static addMilliseconds(timestamp: string, milliseconds: number): string {
    const date = new Date(timestamp);

    return new Date(date.getTime() + milliseconds).toISOString();
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

  private static readLearningJobRow(
    database: DatabaseSync,
    jobId: string,
  ): LearningJobRow | null {
    const row = database
      .prepare(
        `SELECT
          learning_jobs.id,
          learning_jobs.space_id,
          memory_spaces.space_kind,
          memory_spaces.display_name AS space_display_name,
          memory_spaces.origin_url_normalized,
          learning_jobs.root_path,
          learning_jobs.transcript_path,
          learning_jobs.enqueue_key,
          learning_jobs.last_assistant_message,
          learning_jobs.session_id,
          learning_jobs.state,
          learning_jobs.lease_owner,
          learning_jobs.lease_expires_at,
          learning_jobs.attempt_count,
          learning_jobs.error_text,
          learning_jobs.enqueued_at,
          learning_jobs.started_at,
          learning_jobs.finished_at,
          learning_jobs.updated_at
        FROM learning_jobs
        LEFT JOIN memory_spaces ON memory_spaces.id = learning_jobs.space_id
        WHERE learning_jobs.id = ?`,
      )
      .get(jobId);

    if (!row) {
      return null;
    }

    return LearningJobRepository.hydrateLearningJobRow(row as Record<string, unknown>);
  }

  private static readActiveJobByEnqueueKey(
    database: DatabaseSync,
    enqueueKey: string,
  ): LearningJobRow | null {
    const row = database
      .prepare(
        `SELECT
          learning_jobs.id,
          learning_jobs.space_id,
          memory_spaces.space_kind,
          memory_spaces.display_name AS space_display_name,
          memory_spaces.origin_url_normalized,
          learning_jobs.root_path,
          learning_jobs.transcript_path,
          learning_jobs.enqueue_key,
          learning_jobs.last_assistant_message,
          learning_jobs.session_id,
          learning_jobs.state,
          learning_jobs.lease_owner,
          learning_jobs.lease_expires_at,
          learning_jobs.attempt_count,
          learning_jobs.error_text,
          learning_jobs.enqueued_at,
          learning_jobs.started_at,
          learning_jobs.finished_at,
          learning_jobs.updated_at
        FROM learning_jobs
        LEFT JOIN memory_spaces ON memory_spaces.id = learning_jobs.space_id
        WHERE learning_jobs.enqueue_key = ?
          AND learning_jobs.state IN ('pending', 'leased', 'running')
        ORDER BY learning_jobs.enqueued_at ASC, learning_jobs.id ASC
        LIMIT 1`,
      )
      .get(enqueueKey);

    if (!row) {
      return null;
    }

    return LearningJobRepository.hydrateLearningJobRow(row as Record<string, unknown>);
  }

  private static requireLearningJob(database: DatabaseSync, jobId: string): LearningJobRow {
    const row = LearningJobRepository.readLearningJobRow(database, jobId);

    if (!row) {
      throw new Error(`Unable to find learning job "${jobId}".`);
    }

    return row;
  }

  private static readLearningJob(
    database: DatabaseSync,
    jobId: string,
  ): PersistedLearningJob {
    return LearningJobRepository.mapLearningJobRow(
      LearningJobRepository.requireLearningJob(database, jobId),
    );
  }

  private static hasActiveLiveLease(database: DatabaseSync, leasedAt: string): boolean {
    const row = database
      .prepare(
        `SELECT count(*) AS count
        FROM learning_jobs
        WHERE state IN ('leased', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`,
      )
      .get(leasedAt) as { count: number };

    return row.count > 0;
  }

  private static readNextLeasableJobRow(
    database: DatabaseSync,
    leasedAt: string,
  ): LearningJobRow | null {
    const row = database
      .prepare(
        `SELECT
          learning_jobs.id,
          learning_jobs.space_id,
          memory_spaces.space_kind,
          memory_spaces.display_name AS space_display_name,
          memory_spaces.origin_url_normalized,
          learning_jobs.root_path,
          learning_jobs.transcript_path,
          learning_jobs.enqueue_key,
          learning_jobs.last_assistant_message,
          learning_jobs.session_id,
          learning_jobs.state,
          learning_jobs.lease_owner,
          learning_jobs.lease_expires_at,
          learning_jobs.attempt_count,
          learning_jobs.error_text,
          learning_jobs.enqueued_at,
          learning_jobs.started_at,
          learning_jobs.finished_at,
          learning_jobs.updated_at
        FROM learning_jobs
        LEFT JOIN memory_spaces ON memory_spaces.id = learning_jobs.space_id
        WHERE learning_jobs.state = 'pending'
          OR (
            learning_jobs.state IN ('leased', 'running')
            AND (
              learning_jobs.lease_expires_at IS NULL
              OR learning_jobs.lease_expires_at <= ?
            )
          )
        ORDER BY
          CASE learning_jobs.state
            WHEN 'pending' THEN 0
            WHEN 'leased' THEN 1
            WHEN 'running' THEN 2
            ELSE 3
          END,
          learning_jobs.enqueued_at ASC,
          learning_jobs.id ASC
        LIMIT 1`,
      )
      .get(leasedAt);

    if (!row) {
      return null;
    }

    return LearningJobRepository.hydrateLearningJobRow(row as Record<string, unknown>);
  }

  private static finalizeLearningJob(
    database: DatabaseSync,
    state: "completed" | "failed" | "skipped",
    input: FinalizeLearningJobInput,
  ): PersistedLearningJob | null {
    return SqliteService.transaction(database, () => {
      const leaseOwner = LearningJobRepository.normalizeRequiredText(
        input.leaseOwner,
        "leaseOwner",
      );
      const finishedAt = LearningJobRepository.normalizeTimestamp(
        input.finishedAt,
        "finishedAt",
      );
      const errorText =
        state === "completed"
          ? null
          : LearningJobRepository.normalizeNullableText(input.errorText);
      const updateResult = database
        .prepare(
          `UPDATE learning_jobs
          SET
            state = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_text = ?,
            finished_at = ?,
            updated_at = ?
          WHERE id = ?
            AND state IN ('leased', 'running')
            AND lease_owner = ?`,
        )
        .run(state, errorText, finishedAt, finishedAt, input.jobId, leaseOwner);

      if (updateResult.changes === 0) {
        return null;
      }

      return LearningJobRepository.readLearningJob(database, input.jobId);
    });
  }

  static enqueueLearningJob(
    database: DatabaseSync,
    input: EnqueueLearningJobInput,
  ): PersistedLearningJob {
    return SqliteService.transaction(database, () => {
      const normalizedSpaceId = LearningJobRepository.normalizeRequiredText(
        input.spaceId,
        "spaceId",
      );
      const normalizedRootPath = LearningJobRepository.normalizeRequiredText(
        input.rootPath,
        "rootPath",
      );
      const normalizedTranscriptPath = LearningJobRepository.normalizeRequiredText(
        input.transcriptPath,
        "transcriptPath",
      );
      const normalizedEnqueueKey = LearningJobRepository.normalizeEnqueueKey(
        input.enqueueKey,
      );

      if (normalizedEnqueueKey) {
        const existingActiveJob = LearningJobRepository.readActiveJobByEnqueueKey(
          database,
          normalizedEnqueueKey,
        );

        if (existingActiveJob) {
          return LearningJobRepository.mapLearningJobRow(existingActiveJob);
        }
      }

      const jobId = input.id ?? randomUUID();
      const enqueuedAt = input.enqueuedAt ?? new Date().toISOString();
      const updatedAt = input.updatedAt ?? enqueuedAt;
      const attemptCount = LearningJobRepository.normalizeAttemptCount(
        input.attemptCount ?? 0,
      );
      const insertResult = database
        .prepare(
          `INSERT OR IGNORE INTO learning_jobs (
            id,
            space_id,
            root_path,
            transcript_path,
            enqueue_key,
            last_assistant_message,
            session_id,
            state,
            lease_owner,
            lease_expires_at,
            attempt_count,
            error_text,
            enqueued_at,
            started_at,
            finished_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          normalizedSpaceId,
          normalizedRootPath,
          normalizedTranscriptPath,
          normalizedEnqueueKey,
          LearningJobRepository.normalizeNullableText(input.lastAssistantMessage),
          LearningJobRepository.normalizeNullableText(input.sessionId),
          input.state ?? "pending",
          LearningJobRepository.normalizeNullableText(input.leaseOwner),
          LearningJobRepository.normalizeNullableText(input.leaseExpiresAt),
          attemptCount,
          LearningJobRepository.normalizeNullableText(input.errorText),
          enqueuedAt,
          LearningJobRepository.normalizeNullableText(input.startedAt),
          LearningJobRepository.normalizeNullableText(input.finishedAt),
          updatedAt,
        );

      if (insertResult.changes === 1) {
        return LearningJobRepository.readLearningJob(database, jobId);
      }

      if (normalizedEnqueueKey) {
        const existingActiveJob = LearningJobRepository.readActiveJobByEnqueueKey(
          database,
          normalizedEnqueueKey,
        );

        if (existingActiveJob) {
          return LearningJobRepository.mapLearningJobRow(existingActiveJob);
        }
      }

      throw new Error("Failed to enqueue learning job.");
    });
  }

  static getLearningJobById(
    database: DatabaseSync,
    jobId: string,
  ): PersistedLearningJob | null {
    const row = LearningJobRepository.readLearningJobRow(database, jobId);

    if (!row) {
      return null;
    }

    return LearningJobRepository.mapLearningJobRow(row);
  }

  static listLearningJobs(
    database: DatabaseSync,
    options: ListLearningJobsOptions = {},
  ): PersistedLearningJob[] {
    const whereClauses: string[] = [];
    const parameters: string[] = [];
    const limit = LearningJobRepository.normalizeLimit(options.limit);

    if (options.state !== undefined) {
      whereClauses.push("state = ?");
      parameters.push(options.state);
    }

    if (options.spaceId !== undefined) {
      whereClauses.push("space_id = ?");
      parameters.push(
        LearningJobRepository.normalizeRequiredText(options.spaceId, "spaceId"),
      );
    }

    let query = `
      SELECT
        learning_jobs.id,
        learning_jobs.space_id,
        memory_spaces.space_kind,
        memory_spaces.display_name AS space_display_name,
        memory_spaces.origin_url_normalized,
        learning_jobs.root_path,
        learning_jobs.transcript_path,
        learning_jobs.enqueue_key,
        learning_jobs.last_assistant_message,
        learning_jobs.session_id,
        learning_jobs.state,
        learning_jobs.lease_owner,
        learning_jobs.lease_expires_at,
        learning_jobs.attempt_count,
        learning_jobs.error_text,
        learning_jobs.enqueued_at,
        learning_jobs.started_at,
        learning_jobs.finished_at,
        learning_jobs.updated_at
      FROM learning_jobs
      LEFT JOIN memory_spaces ON memory_spaces.id = learning_jobs.space_id
    `;

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    query += ` ORDER BY learning_jobs.enqueued_at ASC, learning_jobs.id ASC LIMIT ${String(limit)}`;

    const rows = database.prepare(query).all(...parameters) as Record<
      string,
      unknown
    >[];

    return rows.map((row) =>
      LearningJobRepository.mapLearningJobRow(
        LearningJobRepository.hydrateLearningJobRow(row),
      ),
    );
  }

  static leaseNextLearningJob(
    database: DatabaseSync,
    input: LeaseLearningJobInput,
  ): PersistedLearningJob | null {
    return SqliteService.transaction(database, () => {
      const leaseOwner = LearningJobRepository.normalizeRequiredText(
        input.leaseOwner,
        "leaseOwner",
      );
      const leaseDurationMs = LearningJobRepository.normalizeLeaseDurationMs(
        input.leaseDurationMs,
      );
      const leasedAt = LearningJobRepository.normalizeTimestamp(
        input.leasedAt,
        "leasedAt",
      );

      if (LearningJobRepository.hasActiveLiveLease(database, leasedAt)) {
        return null;
      }

      const nextJob = LearningJobRepository.readNextLeasableJobRow(
        database,
        leasedAt,
      );

      if (!nextJob) {
        return null;
      }

      const leaseExpiresAt = LearningJobRepository.addMilliseconds(
        leasedAt,
        leaseDurationMs,
      );

      database
        .prepare(
          `UPDATE learning_jobs
          SET
            state = 'leased',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_count = ?,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(
          leaseOwner,
          leaseExpiresAt,
          nextJob.attempt_count + 1,
          leasedAt,
          nextJob.id,
        );

      return LearningJobRepository.readLearningJob(database, nextJob.id);
    });
  }

  static startLearningJob(
    database: DatabaseSync,
    input: StartLearningJobInput,
  ): PersistedLearningJob | null {
    return SqliteService.transaction(database, () => {
      const leaseOwner = LearningJobRepository.normalizeRequiredText(
        input.leaseOwner,
        "leaseOwner",
      );
      const startedAt = LearningJobRepository.normalizeTimestamp(
        input.startedAt,
        "startedAt",
      );
      const updateResult = database
        .prepare(
          `UPDATE learning_jobs
          SET
            state = 'running',
            started_at = COALESCE(started_at, ?),
            updated_at = ?
          WHERE id = ?
            AND state = 'leased'
            AND lease_owner = ?`,
        )
        .run(startedAt, startedAt, input.jobId, leaseOwner);

      if (updateResult.changes === 0) {
        return null;
      }

      return LearningJobRepository.readLearningJob(database, input.jobId);
    });
  }

  static heartbeatLearningJob(
    database: DatabaseSync,
    input: HeartbeatLearningJobInput,
  ): PersistedLearningJob | null {
    return SqliteService.transaction(database, () => {
      const leaseOwner = LearningJobRepository.normalizeRequiredText(
        input.leaseOwner,
        "leaseOwner",
      );
      const heartbeatedAt = LearningJobRepository.normalizeTimestamp(
        input.heartbeatedAt,
        "heartbeatedAt",
      );
      const leaseDurationMs = LearningJobRepository.normalizeLeaseDurationMs(
        input.leaseDurationMs,
      );
      const leaseExpiresAt = LearningJobRepository.addMilliseconds(
        heartbeatedAt,
        leaseDurationMs,
      );
      const updateResult = database
        .prepare(
          `UPDATE learning_jobs
          SET
            lease_expires_at = ?,
            updated_at = ?
          WHERE id = ?
            AND state IN ('leased', 'running')
            AND lease_owner = ?`,
        )
        .run(leaseExpiresAt, heartbeatedAt, input.jobId, leaseOwner);

      if (updateResult.changes === 0) {
        return null;
      }

      return LearningJobRepository.readLearningJob(database, input.jobId);
    });
  }

  static completeLearningJob(
    database: DatabaseSync,
    input: FinalizeLearningJobInput,
  ): PersistedLearningJob | null {
    return LearningJobRepository.finalizeLearningJob(database, "completed", input);
  }

  static failLearningJob(
    database: DatabaseSync,
    input: FinalizeLearningJobInput,
  ): PersistedLearningJob | null {
    return LearningJobRepository.finalizeLearningJob(database, "failed", input);
  }

  static skipLearningJob(
    database: DatabaseSync,
    input: FinalizeLearningJobInput,
  ): PersistedLearningJob | null {
    return LearningJobRepository.finalizeLearningJob(database, "skipped", input);
  }

  static updateLearningJob(
    database: DatabaseSync,
    input: UpdateLearningJobInput,
  ): PersistedLearningJob {
    return SqliteService.transaction(database, () => {
      const existingJob = LearningJobRepository.requireLearningJob(database, input.jobId);
      let nextLastAssistantMessage = existingJob.last_assistant_message;
      let nextSessionId = existingJob.session_id;
      let nextState = existingJob.state;
      let nextLeaseOwner = existingJob.lease_owner;
      let nextLeaseExpiresAt = existingJob.lease_expires_at;
      let nextAttemptCount = existingJob.attempt_count;
      let nextErrorText = existingJob.error_text;
      let nextStartedAt = existingJob.started_at;
      let nextFinishedAt = existingJob.finished_at;

      if (Object.hasOwn(input, "lastAssistantMessage")) {
        nextLastAssistantMessage = LearningJobRepository.normalizeNullableText(
          input.lastAssistantMessage,
        );
      }

      if (Object.hasOwn(input, "sessionId")) {
        nextSessionId = LearningJobRepository.normalizeNullableText(input.sessionId);
      }

      if (input.state !== undefined) {
        nextState = input.state;
      }

      if (Object.hasOwn(input, "leaseOwner")) {
        nextLeaseOwner = LearningJobRepository.normalizeNullableText(input.leaseOwner);
      }

      if (Object.hasOwn(input, "leaseExpiresAt")) {
        nextLeaseExpiresAt = LearningJobRepository.normalizeNullableText(
          input.leaseExpiresAt,
        );
      }

      if (input.attemptCount !== undefined) {
        nextAttemptCount = LearningJobRepository.normalizeAttemptCount(
          input.attemptCount,
        );
      }

      if (Object.hasOwn(input, "errorText")) {
        nextErrorText = LearningJobRepository.normalizeNullableText(input.errorText);
      }

      if (Object.hasOwn(input, "startedAt")) {
        nextStartedAt = LearningJobRepository.normalizeNullableText(input.startedAt);
      }

      if (Object.hasOwn(input, "finishedAt")) {
        nextFinishedAt = LearningJobRepository.normalizeNullableText(input.finishedAt);
      }

      const updatedAt = input.updatedAt ?? new Date().toISOString();

      database
        .prepare(
          `UPDATE learning_jobs
          SET
            last_assistant_message = ?,
            session_id = ?,
            state = ?,
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_count = ?,
            error_text = ?,
            started_at = ?,
            finished_at = ?,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(
          nextLastAssistantMessage,
          nextSessionId,
          nextState,
          nextLeaseOwner,
          nextLeaseExpiresAt,
          nextAttemptCount,
          nextErrorText,
          nextStartedAt,
          nextFinishedAt,
          updatedAt,
          input.jobId,
        );

      return LearningJobRepository.readLearningJob(database, input.jobId);
    });
  }
}
