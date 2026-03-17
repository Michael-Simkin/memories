import {
  DEFAULT_ENGINE_REQUEST_TIMEOUT_MS,
  postEngineJson,
} from "../engine/engine-client.js";
import {
  ensureEngine,
  type EnsureEngineOptions,
} from "../engine/ensure-engine.js";
import { currentContextSchema } from "../shared/schemas/space.js";
import type { PinnedMemoriesResult } from "../shared/types/memory.js";
import {
  isMainModule,
  readHookInputJson,
  writeHookJsonResponse,
} from "./hook-runtime.js";
import { sessionStartHookInputSchema } from "./schemas/session-start.js";
import type {
  SessionStartHookInput,
  SessionStartHookOutput,
} from "./types/session-start.js";

interface SessionStartHookOptions extends EnsureEngineOptions {
  requestTimeoutMs?: number | undefined;
}

function buildStartupAdditionalContext(
  pinnedMemories: PinnedMemoriesResult,
): string {
  const lines = [
    "# Claude Memory Startup",
    "",
    `Active space kind: \`${pinnedMemories.space.space_kind}\``,
    `Active space: \`${pinnedMemories.space.space_display_name}\``,
  ];

  if (pinnedMemories.space.origin_url_normalized) {
    lines.push(
      `Normalized origin: \`${pinnedMemories.space.origin_url_normalized}\``,
    );
  }

  lines.push(
    "",
    "Pinned startup memory below is only for the current active space, not the full memory set.",
    "Use `recall` before acting on non-trivial work and again when project context changes.",
    "If remembered constraints conflict with the requested action, stop and explain the conflict.",
    "",
    "## Pinned Memories",
    "",
  );

  if (pinnedMemories.memories.length === 0) {
    lines.push("_No pinned memories for this active space._");
    return lines.join("\n");
  }

  pinnedMemories.memories.forEach((memory, index) => {
    lines.push(`### ${String(index + 1)}. \`${memory.memory_type}\``);
    lines.push(memory.content);

    if (memory.tags.length > 0) {
      lines.push("", `Tags: ${memory.tags.map((tag) => `\`${tag}\``).join(", ")}`);
    }

    if (memory.path_matchers.length > 0) {
      lines.push(
        "",
        `Path matchers: ${memory.path_matchers
          .map((matcher) => `\`${matcher}\``)
          .join(", ")}`,
      );
    }

    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

export async function handleSessionStartHook(
  input: SessionStartHookInput,
  options: SessionStartHookOptions = {},
): Promise<SessionStartHookOutput> {
  const currentContext = currentContextSchema.parse({
    cwd: input.cwd,
  });
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_ENGINE_REQUEST_TIMEOUT_MS;
  const ensuredEngine = await ensureEngine(options);
  const pinnedMemories = await postEngineJson<PinnedMemoriesResult>(
    ensuredEngine.connection,
    "/memories/pinned",
    {
      context: currentContext,
    },
    requestTimeoutMs,
  );

  return {
    systemMessage: `Claude Memory UI: ${ensuredEngine.baseUrl}/ui?cwd=${encodeURIComponent(
      input.cwd,
    )}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildStartupAdditionalContext(pinnedMemories),
    },
  };
}

export async function runSessionStartHook(
  options: SessionStartHookOptions = {},
): Promise<void> {
  try {
    const hookInput = sessionStartHookInputSchema.parse(await readHookInputJson());
    const output = await handleSessionStartHook(hookInput, options);

    writeHookJsonResponse(output);
  } catch {
    // Hooks must stay fail-open during the rebuild.
  }
}

if (isMainModule(import.meta.url)) {
  void runSessionStartHook();
}
