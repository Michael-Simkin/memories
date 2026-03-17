import type { z } from "zod";

import type { userPromptSubmitHookInputSchema } from "../schemas/user-prompt-submit.js";

export type UserPromptSubmitHookInput = z.infer<
  typeof userPromptSubmitHookInputSchema
>;

export interface UserPromptSubmitHookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}
