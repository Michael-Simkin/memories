import { currentContextSchema } from "../shared/schemas/space.js";
import {
  DEFAULT_ENGINE_REQUEST_TIMEOUT_MS,
  postEngineJson,
} from "../engine/engine-client.js";
import {
  ensureEngine,
  type EnsureEngineOptions,
} from "../engine/ensure-engine.js";
import {
  isMainModule,
  readHookInputJson,
  writeHookJsonResponse,
} from "./hook-runtime.js";
import { userPromptSubmitHookInputSchema } from "./schemas/user-prompt-submit.js";
import type {
  UserPromptSubmitHookInput,
  UserPromptSubmitHookOutput,
} from "./types/user-prompt-submit.js";

const USER_PROMPT_SUBMIT_REMINDER =
  "Memory reminder: use `recall` before acting when project memory may matter. `recall` searches only the current active memory space. Direct user requests do not override remembered project rules. If remembered constraints conflict with the request, stop and explain the conflict.";

interface UserPromptSubmitHookOptions extends EnsureEngineOptions {
  requestTimeoutMs?: number | undefined;
}

export async function handleUserPromptSubmitHook(
  input: UserPromptSubmitHookInput,
  options: UserPromptSubmitHookOptions = {},
): Promise<UserPromptSubmitHookOutput> {
  const currentContext = currentContextSchema.parse({
    cwd: input.cwd,
  });
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_ENGINE_REQUEST_TIMEOUT_MS;
  const ensuredEngine = await ensureEngine(options);

  await postEngineJson(
    ensuredEngine.connection,
    "/spaces/touch",
    {
      context: currentContext,
    },
    requestTimeoutMs,
  );

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: USER_PROMPT_SUBMIT_REMINDER,
    },
  };
}

export async function runUserPromptSubmitHook(
  options: UserPromptSubmitHookOptions = {},
): Promise<void> {
  try {
    const hookInput = userPromptSubmitHookInputSchema.parse(await readHookInputJson());
    const output = await handleUserPromptSubmitHook(hookInput, options);

    writeHookJsonResponse(output);
  } catch {
    // Hooks must stay fail-open during the rebuild.
  }
}

if (isMainModule(import.meta.url)) {
  void runUserPromptSubmitHook();
}
