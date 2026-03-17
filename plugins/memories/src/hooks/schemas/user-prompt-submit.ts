import { z } from "zod";

import { nonEmptyStringSchema } from "../../shared/schemas/common.js";
import { commonHookInputSchema } from "./common.js";

export const userPromptSubmitHookInputSchema = commonHookInputSchema
  .extend({
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: nonEmptyStringSchema,
  })
  .strict();
