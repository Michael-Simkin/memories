import type { z } from "zod";

import type { sessionStartHookInputSchema } from "../schemas/session-start.js";

export type SessionStartHookInput = z.infer<typeof sessionStartHookInputSchema>;

export interface SessionStartHookOutput {
  systemMessage: string;
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}
