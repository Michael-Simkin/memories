import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { PluginPathsService } from "../shared/services/plugin-paths-service.js";
import type { PluginPathResolutionInput } from "../shared/types/plugin-paths.js";

async function canReadFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readUiHtml(
  input: PluginPathResolutionInput = {},
): Promise<string> {
  const pluginRootPath = PluginPathsService.resolvePluginRoot(input);
  const builtUiPath = path.join(pluginRootPath, "dist", "ui", "index.html");

  if (await canReadFile(builtUiPath)) {
    return readFile(builtUiPath, "utf8");
  }

  const sourceUiPath = path.join(pluginRootPath, "web", "src", "index.html");

  if (await canReadFile(sourceUiPath)) {
    return readFile(sourceUiPath, "utf8");
  }

  throw new Error("Unable to find the Claude Memory UI assets.");
}
