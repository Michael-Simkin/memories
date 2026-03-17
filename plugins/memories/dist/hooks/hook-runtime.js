import path from "node:path";
import { fileURLToPath } from "node:url";
async function readHookInputText() {
  let hookInputText = "";
  for await (const chunk of process.stdin) {
    const typedChunk = chunk;
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
async function readHookInputJson() {
  const hookInputText = await readHookInputText();
  return JSON.parse(hookInputText);
}
async function runNoopHook() {
  try {
    await readHookInputText();
  } catch {
  }
}
function isMainModule(importMetaUrl) {
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    return false;
  }
  return path.resolve(invokedPath) === fileURLToPath(importMetaUrl);
}
export {
  isMainModule,
  readHookInputJson,
  readHookInputText,
  runNoopHook
};
