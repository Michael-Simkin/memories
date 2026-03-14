import type { z } from "zod";

import type {
  eventKindSchema,
  eventRecordSchema,
  eventStatusSchema,
} from "../schemas/events.js";

export type EventKind = z.infer<typeof eventKindSchema>;
export type EventRecord = z.infer<typeof eventRecordSchema>;
export type EventStatus = z.infer<typeof eventStatusSchema>;
