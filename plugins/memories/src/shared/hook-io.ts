import type { z } from 'zod';

export interface HookResult {
  continue: true;
  stopReason?: string;
  suppressOutput?: boolean;
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
  const text = await readStdinText();
  if (!text) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

export function writeHookOutput(payload: HookResult): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function writeFailOpenOutput(): void {
  writeHookOutput({ continue: true });
}
