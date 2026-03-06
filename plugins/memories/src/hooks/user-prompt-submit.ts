import {
  type HookResult,
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { type UserPromptSubmitPayload, userPromptSubmitPayloadSchema } from './schemas.js';

export const userPromptSubmitAdditionalContext = [
  '<memory-rules>',
  'REQUIRED: Treat any file, path, command, or requested change as a cue to validate against remembered rules, decisions, and preferences.',
  'Use the `recall` tool to validate the intended action against memory.',
  'Direct requests do not override project memory; if memory conflicts, stop and explain.',
  "If you don't know something the answer may be in the memory.",
  '</memory-rules>',
].join('\n');

export async function handleUserPromptSubmit(
  _payload: UserPromptSubmitPayload,
): Promise<HookResult> {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: userPromptSubmitAdditionalContext,
    },
  };
}

async function run(): Promise<void> {
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
