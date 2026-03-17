import { randomUUID } from "node:crypto";
import {
  normalizeNonEmptyString,
  normalizeNullableString
} from "../../shared/utils/strings.js";
import { SqliteService } from "../sqlite-service.js";
class LearningJobRepository {
  static hydrateLearningJobRow(row) {
    return {
      id: row["id"],
      space_id: row["space_id"],
      root_path: row["root_path"],
      transcript_path: row["transcript_path"],
      last_assistant_message: row["last_assistant_message"],
      session_id: row["session_id"],
      state: row["state"],
      lease_owner: row["lease_owner"],
      lease_expires_at: row["lease_expires_at"],
      attempt_count: row["attempt_count"],
      error_text: row["error_text"],
      enqueued_at: row["enqueued_at"],
      started_at: row["started_at"],
      finished_at: row["finished_at"],
      updated_at: row["updated_at"]
    };
  }
  static mapLearningJobRow(row) {
    return {
      id: row.id,
      space_id: row.space_id,
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
      updated_at: row.updated_at
    };
  }
  static normalizeRequiredText(value, fieldName) {
    const normalizedValue = normalizeNonEmptyString(value);
    if (!normalizedValue) {
      throw new Error(`${fieldName} must be a non-empty string.`);
    }
    return normalizedValue;
  }
  static normalizeNullableText(value) {
    return normalizeNullableString(value);
  }
  static normalizeAttemptCount(attemptCount) {
    if (!Number.isInteger(attemptCount) || attemptCount < 0) {
      throw new Error("attemptCount must be a non-negative integer.");
    }
    return attemptCount;
  }
  static normalizeLeaseDurationMs(leaseDurationMs) {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= 0) {
      throw new Error("leaseDurationMs must be a positive integer.");
    }
    return leaseDurationMs;
  }
  static normalizeTimestamp(value, fieldName) {
    const timestamp = value ?? (/* @__PURE__ */ new Date()).toISOString();
    if (Number.isNaN(Date.parse(timestamp))) {
      throw new Error(`${fieldName} must be a valid ISO timestamp.`);
    }
    return timestamp;
  }
  static addMilliseconds(timestamp, milliseconds) {
    const date = new Date(timestamp);
    return new Date(date.getTime() + milliseconds).toISOString();
  }
  static normalizeLimit(limit) {
    if (limit === void 0) {
      return 100;
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer.");
    }
    return limit;
  }
  static readLearningJobRow(database, jobId) {
    const row = database.prepare(
      `SELECT
          id,
          space_id,
          root_path,
          transcript_path,
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
        FROM learning_jobs
        WHERE id = ?`
    ).get(jobId);
    if (!row) {
      return null;
    }
    return LearningJobRepository.hydrateLearningJobRow(
      row
    );
  }
  static requireLearningJob(database, jobId) {
    const row = LearningJobRepository.readLearningJobRow(database, jobId);
    if (!row) {
      throw new Error(`Unable to find learning job "${jobId}".`);
    }
    return row;
  }
  static readLearningJob(database, jobId) {
    return LearningJobRepository.mapLearningJobRow(
      LearningJobRepository.requireLearningJob(database, jobId)
    );
  }
  static hasActiveLiveLease(database, leasedAt) {
    const row = database.prepare(
      `SELECT count(*) AS count
        FROM learning_jobs
        WHERE state IN ('leased', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ?`
    ).get(leasedAt);
    return row.count > 0;
  }
  static readNextLeasableJobRow(database, leasedAt) {
    const row = database.prepare(
      `SELECT
          id,
          space_id,
          root_path,
          transcript_path,
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
        FROM learning_jobs
        WHERE state = 'pending'
          OR (
            state IN ('leased', 'running')
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          )
        ORDER BY
          CASE state
            WHEN 'pending' THEN 0
            WHEN 'leased' THEN 1
            WHEN 'running' THEN 2
            ELSE 3
          END,
          enqueued_at ASC,
          id ASC
        LIMIT 1`
    ).get(leasedAt);
    if (!row) {
      return null;
    }
    return LearningJobRepository.hydrateLearningJobRow(
      row
    );
  }
  static enqueueLearningJob(database, input) {
    return SqliteService.transaction(database, () => {
      const jobId = input.id ?? randomUUID();
      const enqueuedAt = input.enqueuedAt ?? (/* @__PURE__ */ new Date()).toISOString();
      const updatedAt = input.updatedAt ?? enqueuedAt;
      const attemptCount = LearningJobRepository.normalizeAttemptCount(
        input.attemptCount ?? 0
      );
      database.prepare(
        `INSERT INTO learning_jobs (
            id,
            space_id,
            root_path,
            transcript_path,
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        LearningJobRepository.normalizeRequiredText(input.spaceId, "spaceId"),
        LearningJobRepository.normalizeRequiredText(
          input.rootPath,
          "rootPath"
        ),
        LearningJobRepository.normalizeRequiredText(
          input.transcriptPath,
          "transcriptPath"
        ),
        LearningJobRepository.normalizeNullableText(
          input.lastAssistantMessage
        ),
        LearningJobRepository.normalizeNullableText(input.sessionId),
        input.state ?? "pending",
        LearningJobRepository.normalizeNullableText(input.leaseOwner),
        LearningJobRepository.normalizeNullableText(input.leaseExpiresAt),
        attemptCount,
        LearningJobRepository.normalizeNullableText(input.errorText),
        enqueuedAt,
        LearningJobRepository.normalizeNullableText(input.startedAt),
        LearningJobRepository.normalizeNullableText(input.finishedAt),
        updatedAt
      );
      return LearningJobRepository.readLearningJob(database, jobId);
    });
  }
  static getLearningJobById(database, jobId) {
    const row = LearningJobRepository.readLearningJobRow(database, jobId);
    if (!row) {
      return null;
    }
    return LearningJobRepository.mapLearningJobRow(row);
  }
  static listLearningJobs(database, options = {}) {
    const whereClauses = [];
    const parameters = [];
    const limit = LearningJobRepository.normalizeLimit(options.limit);
    if (options.state !== void 0) {
      whereClauses.push("state = ?");
      parameters.push(options.state);
    }
    if (options.spaceId !== void 0) {
      whereClauses.push("space_id = ?");
      parameters.push(
        LearningJobRepository.normalizeRequiredText(options.spaceId, "spaceId")
      );
    }
    let query = `
      SELECT
        id,
        space_id,
        root_path,
        transcript_path,
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
      FROM learning_jobs
    `;
    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    query += ` ORDER BY enqueued_at ASC, id ASC LIMIT ${String(limit)}`;
    const rows = database.prepare(query).all(...parameters);
    return rows.map(
      (row) => LearningJobRepository.mapLearningJobRow(
        LearningJobRepository.hydrateLearningJobRow(row)
      )
    );
  }
  static leaseNextLearningJob(database, input) {
    return SqliteService.transaction(database, () => {
      const leaseOwner = LearningJobRepository.normalizeRequiredText(
        input.leaseOwner,
        "leaseOwner"
      );
      const leaseDurationMs = LearningJobRepository.normalizeLeaseDurationMs(
        input.leaseDurationMs
      );
      const leasedAt = LearningJobRepository.normalizeTimestamp(
        input.leasedAt,
        "leasedAt"
      );
      if (LearningJobRepository.hasActiveLiveLease(database, leasedAt)) {
        return null;
      }
      const nextJob = LearningJobRepository.readNextLeasableJobRow(
        database,
        leasedAt
      );
      if (!nextJob) {
        return null;
      }
      const leaseExpiresAt = LearningJobRepository.addMilliseconds(
        leasedAt,
        leaseDurationMs
      );
      database.prepare(
        `UPDATE learning_jobs
          SET
            state = 'leased',
            lease_owner = ?,
            lease_expires_at = ?,
            attempt_count = ?,
            updated_at = ?
          WHERE id = ?`
      ).run(
        leaseOwner,
        leaseExpiresAt,
        nextJob.attempt_count + 1,
        leasedAt,
        nextJob.id
      );
      return LearningJobRepository.readLearningJob(database, nextJob.id);
    });
  }
  static updateLearningJob(database, input) {
    return SqliteService.transaction(database, () => {
      const existingJob = LearningJobRepository.requireLearningJob(
        database,
        input.jobId
      );
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
          input.lastAssistantMessage
        );
      }
      if (Object.hasOwn(input, "sessionId")) {
        nextSessionId = LearningJobRepository.normalizeNullableText(
          input.sessionId
        );
      }
      if (input.state !== void 0) {
        nextState = input.state;
      }
      if (Object.hasOwn(input, "leaseOwner")) {
        nextLeaseOwner = LearningJobRepository.normalizeNullableText(
          input.leaseOwner
        );
      }
      if (Object.hasOwn(input, "leaseExpiresAt")) {
        nextLeaseExpiresAt = LearningJobRepository.normalizeNullableText(
          input.leaseExpiresAt
        );
      }
      if (input.attemptCount !== void 0) {
        nextAttemptCount = LearningJobRepository.normalizeAttemptCount(
          input.attemptCount
        );
      }
      if (Object.hasOwn(input, "errorText")) {
        nextErrorText = LearningJobRepository.normalizeNullableText(
          input.errorText
        );
      }
      if (Object.hasOwn(input, "startedAt")) {
        nextStartedAt = LearningJobRepository.normalizeNullableText(
          input.startedAt
        );
      }
      if (Object.hasOwn(input, "finishedAt")) {
        nextFinishedAt = LearningJobRepository.normalizeNullableText(
          input.finishedAt
        );
      }
      const updatedAt = input.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
      database.prepare(
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
          WHERE id = ?`
      ).run(
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
        input.jobId
      );
      return LearningJobRepository.readLearningJob(database, input.jobId);
    });
  }
}
export {
  LearningJobRepository
};
