import type { DatabaseSync } from "node:sqlite";

import {
  normalizeNonEmptyString,
  normalizeNullableString,
} from "../../shared/utils/strings.js";
import { SqliteService } from "../sqlite-service.js";
import type {
  CreateEventInput,
  ListEventsOptions,
  PersistedEventRecord,
} from "../types/event.js";

interface EventRow {
  id: number;
  at: string;
  space_id: string | null;
  space_kind: PersistedEventRecord["space_kind"];
  space_display_name: PersistedEventRecord["space_display_name"];
  origin_url_normalized: PersistedEventRecord["origin_url_normalized"];
  root_path: string | null;
  event: string;
  kind: PersistedEventRecord["kind"];
  status: PersistedEventRecord["status"];
  session_id: string | null;
  memory_id: string | null;
  job_id: string | null;
  detail: string | null;
  data_json: string | null;
}

export class EventRepository {
  private static hydrateEventRow(row: Record<string, unknown>): EventRow {
    return {
      id: row["id"] as number,
      at: row["at"] as string,
      space_id: row["space_id"] as string | null,
      space_kind: row["space_kind"] as PersistedEventRecord["space_kind"],
      space_display_name: row["space_display_name"] as PersistedEventRecord["space_display_name"],
      origin_url_normalized: row["origin_url_normalized"] as PersistedEventRecord["origin_url_normalized"],
      root_path: row["root_path"] as string | null,
      event: row["event"] as string,
      kind: row["kind"] as PersistedEventRecord["kind"],
      status: row["status"] as PersistedEventRecord["status"],
      session_id: row["session_id"] as string | null,
      memory_id: row["memory_id"] as string | null,
      job_id: row["job_id"] as string | null,
      detail: row["detail"] as string | null,
      data_json: row["data_json"] as string | null,
    };
  }

  private static mapEventRow(row: EventRow): PersistedEventRecord {
    return {
      id: row.id,
      at: row.at,
      space_id: row.space_id,
      space_kind: row.space_kind,
      space_display_name: row.space_display_name,
      origin_url_normalized: row.origin_url_normalized,
      root_path: row.root_path,
      event: row.event,
      kind: row.kind,
      status: row.status,
      session_id: row.session_id,
      memory_id: row.memory_id,
      job_id: row.job_id,
      detail: row.detail,
      data: EventRepository.parseEventData(row.data_json),
    };
  }

  private static normalizeRequiredText(
    value: string,
    fieldName: string
  ): string {
    const normalizedValue = normalizeNonEmptyString(value);

    if (!normalizedValue) {
      throw new Error(`${fieldName} must be a non-empty string.`);
    }

    return normalizedValue;
  }

  private static normalizeNullableText(
    value: string | null | undefined
  ): string | null {
    return normalizeNullableString(value);
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

  private static serializeEventData(
    data: Record<string, unknown> | null | undefined
  ): string | null {
    if (data === undefined || data === null) {
      return null;
    }

    if (Array.isArray(data)) {
      throw new Error("Event data must be a JSON object.");
    }

    return JSON.stringify(data);
  }

  private static parseEventData(
    dataJson: string | null
  ): PersistedEventRecord["data"] {
    if (dataJson === null) {
      return null;
    }

    return JSON.parse(dataJson) as PersistedEventRecord["data"];
  }

  private static readEventRow(
    database: DatabaseSync,
    eventId: number
  ): EventRow | null {
    const row = database
      .prepare(
        `SELECT
          events.id,
          events.at,
          events.space_id,
          memory_spaces.space_kind,
          memory_spaces.display_name AS space_display_name,
          memory_spaces.origin_url_normalized,
          events.root_path,
          events.event,
          events.kind,
          events.status,
          events.session_id,
          events.memory_id,
          events.job_id,
          events.detail,
          events.data_json
        FROM events
        LEFT JOIN memory_spaces ON memory_spaces.id = events.space_id
        WHERE events.id = ?`
      )
      .get(eventId);

    if (!row) {
      return null;
    }

    return EventRepository.hydrateEventRow(row as Record<string, unknown>);
  }

  private static requireEvent(
    database: DatabaseSync,
    eventId: number
  ): EventRow {
    const row = EventRepository.readEventRow(database, eventId);

    if (!row) {
      throw new Error(`Unable to find event "${String(eventId)}".`);
    }

    return row;
  }

  static recordEvent(
    database: DatabaseSync,
    input: CreateEventInput
  ): PersistedEventRecord {
    return SqliteService.transaction(database, () => {
      const at = input.at ?? new Date().toISOString();
      const insertResult = database
        .prepare(
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
        )
        .run(
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

  static listEvents(
    database: DatabaseSync,
    options: ListEventsOptions = {}
  ): PersistedEventRecord[] {
    const whereClauses: string[] = [];
    const parameters: string[] = [];
    const limit = EventRepository.normalizeLimit(options.limit);

    if (options.spaceId !== undefined) {
      whereClauses.push("space_id = ?");
      parameters.push(
        EventRepository.normalizeRequiredText(options.spaceId, "spaceId")
      );
    }

    if (options.kind !== undefined) {
      whereClauses.push("kind = ?");
      parameters.push(options.kind);
    }

    if (options.status !== undefined) {
      whereClauses.push("status = ?");
      parameters.push(options.status);
    }

    let query = `
      SELECT
        events.id,
        events.at,
        events.space_id,
        memory_spaces.space_kind,
        memory_spaces.display_name AS space_display_name,
        memory_spaces.origin_url_normalized,
        events.root_path,
        events.event,
        events.kind,
        events.status,
        events.session_id,
        events.memory_id,
        events.job_id,
        events.detail,
        events.data_json
      FROM events
      LEFT JOIN memory_spaces ON memory_spaces.id = events.space_id
    `;

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    query += ` ORDER BY events.id DESC LIMIT ${String(limit)}`;

    const rows = database.prepare(query).all(...parameters) as Record<
      string,
      unknown
    >[];

    return rows.map((row) =>
      EventRepository.mapEventRow(EventRepository.hydrateEventRow(row))
    );
  }
}
