import { access } from "node:fs/promises";
import { currentContextSchema } from "../shared/schemas/space.js";
import { DatabaseBootstrapRepository } from "../storage/repositories/database-bootstrap-repository.js";
import { ActiveSpaceLearningJobRepository } from "../storage/repositories/active-space-learning-job-repository.js";
import { isMainModule, readHookInputJson } from "./hook-runtime.js";
import { stopHookInputSchema } from "./schemas/stop.js";
async function handleStopHook(input, options = {}) {
  if (input.stop_hook_active) {
    return {
      enqueued: false,
      skipReason: "stop-hook-active"
    };
  }
  try {
    await access(input.transcript_path);
  } catch {
    return {
      enqueued: false,
      skipReason: "missing-transcript"
    };
  }
  const currentContext = currentContextSchema.parse({
    cwd: input.cwd
  });
  const bootstrapResult = DatabaseBootstrapRepository.bootstrapDatabase({
    claudeMemoryHome: options.claudeMemoryHome
  });
  try {
    const queuedLearningJob = await ActiveSpaceLearningJobRepository.enqueueLearningJob(
      bootstrapResult.database,
      {
        context: currentContext,
        transcriptPath: input.transcript_path,
        lastAssistantMessage: input.last_assistant_message,
        sessionId: input.session_id
      }
    );
    return {
      enqueued: true,
      jobId: queuedLearningJob.id
    };
  } finally {
    bootstrapResult.database.close();
  }
}
async function runStopHook(options = {}) {
  try {
    const hookInput = stopHookInputSchema.parse(await readHookInputJson());
    await handleStopHook(hookInput, options);
  } catch {
  }
}
if (isMainModule(import.meta.url)) {
  void runStopHook();
}
export {
  handleStopHook,
  runStopHook
};
