import path from "node:path";
import { normalizeNonEmptyString } from "../utils/strings.js";
class PluginPathsService {
  static resolvePluginRoot(input = {}) {
    const configuredPluginRoot = normalizeNonEmptyString(
      input.pluginRoot ?? process.env["CLAUDE_PLUGIN_ROOT"]
    );
    if (!configuredPluginRoot) {
      throw new Error(
        "CLAUDE_PLUGIN_ROOT must be set or pluginRoot must be provided explicitly."
      );
    }
    if (!path.isAbsolute(configuredPluginRoot)) {
      throw new Error("CLAUDE_PLUGIN_ROOT must be an absolute path.");
    }
    return path.normalize(configuredPluginRoot);
  }
  static resolvePluginPaths(input = {}) {
    const pluginRootPath = PluginPathsService.resolvePluginRoot(input);
    return {
      pluginRootPath,
      vendoredSqliteVecPath: path.join(
        pluginRootPath,
        "vendor",
        "sqlite-vec",
        "darwin-arm64",
        "vec0.dylib"
      )
    };
  }
  static resolveVendoredSqliteVecPath(input = {}) {
    return PluginPathsService.resolvePluginPaths(input).vendoredSqliteVecPath;
  }
}
export {
  PluginPathsService
};
