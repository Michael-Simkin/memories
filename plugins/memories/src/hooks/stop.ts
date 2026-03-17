import { access } from "node:fs/promises";

import { currentContextSchema } from "../shared/schemas/space.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { ActiveSpaceLearningJobRepository } from "../storage/repositories/active-space-learning-job-repository.js";
import { isMainModule, readHookInputJson } from "./hook-runtime.js";
import { stopHookInputSchema } from "./schemas/stop.js";
import type { StopHookInput, StopHookResult } from "./types/stop.js";

interface StopHookOptions {
  claudeMemoryHome?: string | undefined;
}

export async function handleStopHook(
  input: StopHookInput,
  options: StopHookOptions = {},
): Promise<StopHookResult> {
  if (input.stop_hook_active) {
    return {
      enqueued: false,
      skipReason: "stop-hook-active",
    };
  }

  try {
    await access(input.transcript_path);
  } catch {
    return {
      enqueued: false,
      skipReason: "missing-transcript",
    };
  }

  const currentContext = currentContextSchema.parse({
    cwd: input.cwd,
  });
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    claudeMemoryHome: options.claudeMemoryHome,
  });

  try {
    const queuedLearningJob =
      await ActiveSpaceLearningJobRepository.enqueueLearningJob(
        bootstrapResult.database,
        {
          context: currentContext,
          transcriptPath: input.transcript_path,
          lastAssistantMessage: input.last_assistant_message,
          sessionId: input.session_id,
        },
      );

    return {
      enqueued: true,
      jobId: queuedLearningJob.id,
    };
  } finally {
    bootstrapResult.database.close();
  }
}

export async function runStopHook(
  options: StopHookOptions = {},
): Promise<void> {
  try {
    const hookInput = stopHookInputSchema.parse(await readHookInputJson());

    await handleStopHook(hookInput, options);
  } catch {
    // Hooks must stay fail-open during the rebuild.
  }
}

if (isMainModule(import.meta.url)) {
  void runStopHook();
}
