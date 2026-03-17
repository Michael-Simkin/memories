import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/__tests__/**"],
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
