import path from "node:path";
import { fileURLToPath } from "node:url";

export async function readHookInputText(): Promise<string> {
  let hookInputText = "";

  for await (const chunk of process.stdin) {
    const typedChunk: unknown = chunk;

    if (typeof typedChunk === "string") {
      hookInputText += typedChunk;
      continue;
    }

    if (typedChunk instanceof Uint8Array) {
      hookInputText += Buffer.from(typedChunk).toString("utf8");
      continue;
    }

    hookInputText += String(typedChunk);
  }

  return hookInputText;
}

export async function readHookInputJson(): Promise<unknown> {
  const hookInputText = await readHookInputText();

  return JSON.parse(hookInputText);
}

export async function runNoopHook(): Promise<void> {
  try {
    await readHookInputText();
  } catch {
    // Hooks must stay fail-open during the rebuild.
  }
}

export function writeHookJsonResponse(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function isMainModule(importMetaUrl: string): boolean {
  const invokedPath = process.argv[1];

  if (!invokedPath) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(importMetaUrl);
}
