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

const nativeRuntimeDependencies = [
  'better-sqlite3',
  'sqlite-vec-darwin-arm64',
  'sqlite-vec-darwin-x64',
  'sqlite-vec-linux-arm64',
  'sqlite-vec-linux-x64',
];

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    'engine/main': 'src/engine/main.ts',
    'extraction/run': 'src/extraction/run.ts',
    'hooks/session-end': 'src/hooks/session-end.ts',
    'hooks/session-start': 'src/hooks/session-start.ts',
    'hooks/stop': 'src/hooks/stop.ts',
    'hooks/user-prompt-submit': 'src/hooks/user-prompt-submit.ts',
    'mcp/search-server': 'src/mcp/search-server.ts',
  },
  external: nativeRuntimeDependencies,
  format: ['esm'],
  noExternal: bundledRuntimeDependencies,
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node20',
});
