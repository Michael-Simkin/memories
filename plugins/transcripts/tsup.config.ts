import { defineConfig } from 'tsup';

const bundledRuntimeDependencies = [
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  'ulid',
  'zod',
];

export default defineConfig({
  banner: {
    js: "import { createRequire as __transcriptsCreateRequire } from 'node:module'; const require = __transcriptsCreateRequire(import.meta.url);",
  },
  clean: true,
  dts: false,
  entry: {
    'hooks/session-start': 'src/hooks/session-start.ts',
    'hooks/session-end': 'src/hooks/session-end.ts',
    'sync/runner': 'src/sync/runner.ts',
    'mcp/server': 'src/mcp/server.ts',
  },
  format: ['esm'],
  noExternal: bundledRuntimeDependencies,
  onSuccess: `sed -i '' 's/from "sqlite"/from "node:sqlite"/g' dist/sync/runner.js dist/mcp/server.js`,
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node24',
});
