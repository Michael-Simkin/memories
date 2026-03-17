import type { z } from "zod";

import type { stopHookInputSchema } from "../schemas/stop.js";

export type StopHookInput = z.infer<typeof stopHookInputSchema>;

export type StopHookSkipReason =
  | "missing-transcript"
  | "stop-hook-active";

export interface StopHookResult {
  enqueued: boolean;
  jobId?: string | undefined;
  skipReason?: StopHookSkipReason | undefined;
}
