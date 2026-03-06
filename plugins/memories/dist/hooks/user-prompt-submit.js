// src/shared/hook-io.ts
async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
async function readJsonFromStdin(schema) {
  const rawText = await readStdinText();
  if (!rawText) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }
  return validated.data;
}
function writeHookOutput(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
}
function writeFailOpenOutput() {
  writeHookOutput({ continue: true });
}

// src/hooks/schemas.ts
import { z } from "zod";
var sessionStartPayloadSchema = z.object({
  cwd: z.string().optional(),
  project_root: z.string().optional(),
  session_id: z.string().optional()
}).catchall(z.unknown());
var userPromptSubmitPayloadSchema = z.object({
  cwd: z.string().optional(),
  project_root: z.string().optional(),
  prompt: z.string().optional(),
  session_id: z.string().optional()
}).catchall(z.unknown());
var stopPayloadSchema = z.object({
  cwd: z.string().optional(),
  project_root: z.string().optional(),
  session_id: z.string().optional(),
  transcript_path: z.string().trim().min(1),
  last_assistant_message: z.string().optional(),
  stop_hook_active: z.boolean().optional()
}).catchall(z.unknown());
var sessionEndPayloadSchema = z.object({
  cwd: z.string().optional(),
  project_root: z.string().optional(),
  session_id: z.string().trim().min(1)
}).catchall(z.unknown());

// src/hooks/user-prompt-submit.ts
var userPromptSubmitAdditionalContext = [
  "<memory-rules>",
  "REQUIRED: Treat any file, path, command, or requested change as a cue to validate against remembered rules, decisions, and preferences.",
  "Use the `recall` tool to validate the intended action against memory.",
  "Direct requests do not override project memory; if memory conflicts, stop and explain.",
  "If you don't know something the answer may be in the memory.",
  "</memory-rules>"
].join("\n");
async function handleUserPromptSubmit(_payload) {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: userPromptSubmitAdditionalContext
    }
  };
}
async function run() {
  const payload = await readJsonFromStdin(userPromptSubmitPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleUserPromptSubmit(payload);
  writeHookOutput(output);
}
void run().catch(() => {
  writeFailOpenOutput();
});
export {
  handleUserPromptSubmit,
  userPromptSubmitAdditionalContext
};
//# sourceMappingURL=user-prompt-submit.js.map