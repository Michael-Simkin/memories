import { currentContextSchema } from "../shared/schemas/space.js";
import { ActiveMemorySpaceService } from "../shared/services/active-memory-space-service.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { SpaceRegistryRepository } from "../storage/repositories/space-registry-repository.js";
import {
  isMainModule,
  readHookInputJson,
  writeHookJsonResponse
} from "./hook-runtime.js";
import { userPromptSubmitHookInputSchema } from "./schemas/user-prompt-submit.js";
const USER_PROMPT_SUBMIT_REMINDER = "Memory reminder: use `recall` before acting when project memory may matter. `recall` searches only the current active memory space. Direct user requests do not override remembered project rules. If remembered constraints conflict with the request, stop and explain the conflict.";
async function handleUserPromptSubmitHook(input, options = {}) {
  const currentContext = currentContextSchema.parse({
    cwd: input.cwd
  });
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    claudeMemoryHome: options.claudeMemoryHome
  });
  try {
    const resolution = await ActiveMemorySpaceService.resolveActiveMemorySpace({
      projectRoot: currentContext.project_root,
      cwd: currentContext.cwd
    });
    SpaceRegistryRepository.touchResolvedMemorySpace(bootstrapResult.database, {
      resolution
    });
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: USER_PROMPT_SUBMIT_REMINDER
      }
    };
  } finally {
    bootstrapResult.database.close();
  }
}
async function runUserPromptSubmitHook(options = {}) {
  try {
    const hookInput = userPromptSubmitHookInputSchema.parse(await readHookInputJson());
    const output = await handleUserPromptSubmitHook(hookInput, options);
    writeHookJsonResponse(output);
  } catch {
  }
}
if (isMainModule(import.meta.url)) {
  void runUserPromptSubmitHook();
}
export {
  handleUserPromptSubmitHook,
  runUserPromptSubmitHook
};
