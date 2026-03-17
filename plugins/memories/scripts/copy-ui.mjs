import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const pluginRootPath = path.join(scriptsDirectoryPath, "..");
const uiSourcePath = path.join(pluginRootPath, "web", "src", "index.html");
const uiTargetDirectoryPath = path.join(pluginRootPath, "dist", "ui");
const uiTargetPath = path.join(uiTargetDirectoryPath, "index.html");

async function rewriteNodeSqliteImports(directoryPath) {
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });

  for (const directoryEntry of directoryEntries) {
    const entryPath = path.join(directoryPath, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      await rewriteNodeSqliteImports(entryPath);
      continue;
    }

    if (!directoryEntry.isFile() || !entryPath.endsWith(".js")) {
      continue;
    }

    const fileText = await readFile(entryPath, "utf8");
    const updatedFileText = fileText.replaceAll(
      'from "sqlite"',
      'from "node:sqlite"',
    );

    if (updatedFileText !== fileText) {
      await writeFile(entryPath, updatedFileText, "utf8");
    }
  }
}

await mkdir(uiTargetDirectoryPath, { recursive: true });
await cp(uiSourcePath, uiTargetPath);
await rewriteNodeSqliteImports(path.join(pluginRootPath, "dist"));
