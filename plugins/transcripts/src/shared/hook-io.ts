import type { z } from 'zod';

export interface HookResult {
  continue: true;
  suppressOutput?: boolean;
  stopReason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function readJsonFromStdin<T>(schema: z.ZodType<T>): Promise<T | null> {
  const rawText = await readStdinText();
  if (!rawText) {
    return null;
  }

  let parsed: unknown;
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

export function writeHookOutput(payload: HookResult): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function writeFailOpenOutput(): void {
  writeHookOutput({ continue: true });
}
