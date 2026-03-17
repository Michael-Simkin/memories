import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "engine/main": "src/engine/main.ts",
    "hooks/session-start": "src/hooks/session-start.ts",
    "hooks/stop": "src/hooks/stop.ts",
    "hooks/user-prompt-submit": "src/hooks/user-prompt-submit.ts",
    "mcp/search-server": "src/mcp/search-server.ts",
  },
  outDir: "dist",
  clean: true,
  bundle: true,
  dts: false,
  format: ["esm"],
  noExternal: ["zod"],
  platform: "node",
  splitting: false,
  sourcemap: false,
  target: "node24",
  treeshake: false,
});
