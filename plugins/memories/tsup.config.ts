import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsup";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.join(configDirectory, "src");

function collectSourceEntries(directoryPath: string): string[] {
  const directoryEntries = readdirSync(directoryPath, {
    withFileTypes: true,
  });
  const collectedEntries: string[] = [];

  for (const directoryEntry of directoryEntries) {
    const entryPath = path.join(directoryPath, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      if (directoryEntry.name === "__tests__") {
        continue;
      }

      collectedEntries.push(...collectSourceEntries(entryPath));
      continue;
    }

    if (directoryEntry.isFile() && directoryEntry.name.endsWith(".ts")) {
      collectedEntries.push(path.relative(configDirectory, entryPath));
    }
  }

  return collectedEntries;
}

const sourceEntries = collectSourceEntries(sourceDirectory).sort();

export default defineConfig({
  entry: sourceEntries,
  outDir: "dist",
  clean: true,
  bundle: false,
  dts: false,
  format: ["esm"],
  platform: "node",
  splitting: false,
  sourcemap: false,
  target: "node24",
  treeshake: false,
});
