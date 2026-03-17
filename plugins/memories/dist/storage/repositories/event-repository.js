import {
  normalizeNonEmptyString,
  normalizeNullableString
} from "../../shared/utils/strings.js";
import { SqliteService } from "../sqlite-service.js";
class EventRepository {
  static hydrateEventRow(row) {
    return {
      id: row["id"],
      at: row["at"],
      space_id: row["space_id"],
      root_path: row["root_path"],
      event: row["event"],
      kind: row["kind"],
      status: row["status"],
      session_id: row["session_id"],
      memory_id: row["memory_id"],
      job_id: row["job_id"],
      detail: row["detail"],
      data_json: row["data_json"]
    };
  }
  static mapEventRow(row) {
    return {
      id: row.id,
      at: row.at,
      space_id: row.space_id,
      root_path: row.root_path,
      event: row.event,
      kind: row.kind,
      status: row.status,
      session_id: row.session_id,
      memory_id: row.memory_id,
      job_id: row.job_id,
      detail: row.detail,
      data: EventRepository.parseEventData(row.data_json)
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
  static normalizeLimit(limit) {
    if (limit === void 0) {
      return 100;
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer.");
    }
    return limit;
  }
  static serializeEventData(data) {
    if (data === void 0 || data === null) {
      return null;
    }
    if (Array.isArray(data)) {
      throw new Error("Event data must be a JSON object.");
    }
    return JSON.stringify(data);
  }
  static parseEventData(dataJson) {
    if (dataJson === null) {
      return null;
    }
    return JSON.parse(dataJson);
  }
  static readEventRow(database, eventId) {
    const row = database.prepare(
      `SELECT
          id,
          at,
          space_id,
          root_path,
          event,
          kind,
          status,
          session_id,
          memory_id,
          job_id,
          detail,
          data_json
        FROM events
        WHERE id = ?`
    ).get(eventId);
    if (!row) {
      return null;
    }
    return EventRepository.hydrateEventRow(row);
  }
  static requireEvent(database, eventId) {
    const row = EventRepository.readEventRow(database, eventId);
    if (!row) {
      throw new Error(`Unable to find event "${String(eventId)}".`);
    }
    return row;
  }
  static recordEvent(database, input) {
    return SqliteService.transaction(database, () => {
      const at = input.at ?? (/* @__PURE__ */ new Date()).toISOString();
      const insertResult = database.prepare(
        `INSERT INTO events (
            at,
            space_id,
            root_path,
            event,
            kind,
            status,
            session_id,
            memory_id,
            job_id,
            detail,
            data_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        at,
        EventRepository.normalizeNullableText(input.spaceId),
        EventRepository.normalizeNullableText(input.rootPath),
        EventRepository.normalizeRequiredText(input.event, "event"),
        input.kind,
        input.status,
        EventRepository.normalizeNullableText(input.sessionId),
        EventRepository.normalizeNullableText(input.memoryId),
        EventRepository.normalizeNullableText(input.jobId),
        EventRepository.normalizeNullableText(input.detail),
        EventRepository.serializeEventData(input.data)
      );
      const eventId = Number(insertResult.lastInsertRowid);
      return EventRepository.mapEventRow(
        EventRepository.requireEvent(database, eventId)
      );
    });
  }
  static listEvents(database, options = {}) {
    const whereClauses = [];
    const parameters = [];
    const limit = EventRepository.normalizeLimit(options.limit);
    if (options.spaceId !== void 0) {
      whereClauses.push("space_id = ?");
      parameters.push(
        EventRepository.normalizeRequiredText(options.spaceId, "spaceId")
      );
    }
    if (options.kind !== void 0) {
      whereClauses.push("kind = ?");
      parameters.push(options.kind);
    }
    if (options.status !== void 0) {
      whereClauses.push("status = ?");
      parameters.push(options.status);
    }
    let query = `
      SELECT
        id,
        at,
        space_id,
        root_path,
        event,
        kind,
        status,
        session_id,
        memory_id,
        job_id,
        detail,
        data_json
      FROM events
    `;
    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(" AND ")}`;
    }
    query += ` ORDER BY id DESC LIMIT ${String(limit)}`;
    const rows = database.prepare(query).all(...parameters);
    return rows.map(
      (row) => EventRepository.mapEventRow(EventRepository.hydrateEventRow(row))
    );
  }
}
export {
  EventRepository
};
