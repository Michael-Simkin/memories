import { currentContextSchema } from "../shared/schemas/space.js";
import { ActiveMemorySpaceService } from "../shared/services/active-memory-space-service.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { SpaceRegistryRepository } from "../storage/repositories/space-registry-repository.js";
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

interface UserPromptSubmitHookOptions {
  claudeMemoryHome?: string | undefined;
}

export async function handleUserPromptSubmitHook(
  input: UserPromptSubmitHookInput,
  options: UserPromptSubmitHookOptions = {},
): Promise<UserPromptSubmitHookOutput> {
  const currentContext = currentContextSchema.parse({
    cwd: input.cwd,
  });
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    claudeMemoryHome: options.claudeMemoryHome,
  });

  try {
    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace({
      projectRoot: currentContext.project_root,
      cwd: currentContext.cwd,
    });

    SpaceRegistryRepository.touchResolvedMemorySpace(bootstrapResult.database, {
      resolution,
    });

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: USER_PROMPT_SUBMIT_REMINDER,
      },
    };
  } finally {
    bootstrapResult.database.close();
  }
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
