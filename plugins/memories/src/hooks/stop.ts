import { access } from "node:fs/promises";

import { currentContextSchema } from "../shared/schemas/space.js";
import {
  DEFAULT_ENGINE_REQUEST_TIMEOUT_MS,
  postEngineJson,
} from "../engine/engine-client.js";
import {
  ensureEngine,
  type EnsureEngineOptions,
} from "../engine/ensure-engine.js";
import { isMainModule, readHookInputJson } from "./hook-runtime.js";
import { stopHookInputSchema } from "./schemas/stop.js";
import type { StopHookInput, StopHookResult } from "./types/stop.js";

interface StopHookOptions extends EnsureEngineOptions {
  requestTimeoutMs?: number | undefined;
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
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_ENGINE_REQUEST_TIMEOUT_MS;
  const ensuredEngine = await ensureEngine(options);
  const response = await postEngineJson<{ job: { id: string } }>(
    ensuredEngine.connection,
    "/learning-jobs",
    {
      context: currentContext,
      transcript_path: input.transcript_path,
      last_assistant_message: input.last_assistant_message,
      session_id: input.session_id,
    },
    requestTimeoutMs,
  );

  return {
    enqueued: true,
    jobId: response.job.id,
  };
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
