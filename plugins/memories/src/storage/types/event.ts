import type {
  EventKind,
  EventRecord,
  EventStatus,
} from "../../shared/types/events.js";

export interface CreateEventInput {
  at?: string | undefined;
  spaceId?: string | null | undefined;
  rootPath?: string | null | undefined;
  event: string;
  kind: EventKind;
  status: EventStatus;
  sessionId?: string | null | undefined;
  memoryId?: string | null | undefined;
  jobId?: string | null | undefined;
  detail?: string | null | undefined;
  data?: Record<string, unknown> | null | undefined;
}

export interface ListEventsOptions {
  spaceId?: string | undefined;
  kind?: EventKind | undefined;
  status?: EventStatus | undefined;
  limit?: number | undefined;
}

export interface PersistedEventRecord extends EventRecord {
  id: number;
}
