import { defineConfig } from 'tsup';

const bundledRuntimeDependencies = [
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  'express',
  'picomatch',
  'ulid',
  'zod',
];

export default defineConfig({
  banner: {
    js: "import { createRequire as __memoriesCreateRequire } from 'node:module'; const require = __memoriesCreateRequire(import.meta.url);",
  },
  clean: true,
  dts: false,
  entry: {
    'engine/main': 'src/engine/main.ts',
    'extraction/run': 'src/extraction/run.ts',
'hooks/session-start': 'src/hooks/session-start.ts',
    'hooks/stop': 'src/hooks/stop.ts',
    'hooks/user-prompt-submit': 'src/hooks/user-prompt-submit.ts',
    'mcp/search-server': 'src/mcp/search-server.ts',
  },
  format: ['esm'],
  noExternal: bundledRuntimeDependencies,
  onSuccess: `sed -i '' 's/from "sqlite"/from "node:sqlite"/g' dist/engine/main.js`,
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node24',
});
