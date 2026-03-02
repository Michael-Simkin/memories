import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    'engine/main': 'src/engine/main.ts',
    'extraction/run': 'src/extraction/run.ts',
    'hooks/pretool-use': 'src/hooks/pretool-use.ts',
    'hooks/session-end': 'src/hooks/session-end.ts',
    'hooks/session-start': 'src/hooks/session-start.ts',
    'hooks/stop': 'src/hooks/stop.ts',
    'mcp/search-server': 'src/mcp/search-server.ts',
  },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  format: ['esm'],
  noExternal: [/^(?!node:)/],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node24',
  onSuccess: "sed -i '' 's/from \"sqlite\"/from \"node:sqlite\"/g' dist/engine/main.js",
});
