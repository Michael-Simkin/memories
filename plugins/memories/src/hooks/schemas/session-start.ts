import { z } from "zod";

import { commonHookInputSchema } from "./common.js";

export const sessionStartHookInputSchema = commonHookInputSchema
  .extend({
    hook_event_name: z.literal("SessionStart"),
  })
  .strict();
