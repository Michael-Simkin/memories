import { accessSync, constants } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { PluginPathsService } from "../shared/services/plugin-paths-service.js";
import type { PluginPathResolutionInput } from "../shared/types/plugin-paths.js";

function assertVendoredBinaryReadable(vendoredSqliteVecPath: string): void {
  try {
    accessSync(vendoredSqliteVecPath, constants.R_OK);
  } catch (error) {
    throw new Error(
      `Vendored sqlite-vec binary is missing or unreadable at "${vendoredSqliteVecPath}". Check CLAUDE_PLUGIN_ROOT and ensure the darwin-arm64 vendor asset is packaged.`,
      { cause: error },
    );
  }
}

export function loadSqliteVecExtension(
  database: DatabaseSync,
  input: PluginPathResolutionInput = {},
): void {
  const vendoredSqliteVecPath =
    PluginPathsService.resolveVendoredSqliteVecPath(input);

  assertVendoredBinaryReadable(vendoredSqliteVecPath);

  try {
    database.loadExtension(vendoredSqliteVecPath);
  } catch (error) {
    throw new Error(
      `Failed to load vendored sqlite-vec extension from "${vendoredSqliteVecPath}". Verify the committed darwin-arm64 binary matches the supported runtime and is not corrupted.`,
      { cause: error },
    );
  }
}
