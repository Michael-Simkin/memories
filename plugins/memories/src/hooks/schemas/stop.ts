import { z } from "zod";

import { nullableNonEmptyStringSchema } from "../../shared/schemas/common.js";
import { commonHookInputSchema } from "./common.js";

export const stopHookInputSchema = commonHookInputSchema
  .extend({
    hook_event_name: z.literal("Stop"),
    stop_hook_active: z.boolean(),
    last_assistant_message: nullableNonEmptyStringSchema,
  })
  .strict();
