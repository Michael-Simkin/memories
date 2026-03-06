import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: false,
  entry: {
    'engine/main': 'src/engine/main.ts',
    'extraction/run': 'src/extraction/run.ts',
    'hooks/session-end': 'src/hooks/session-end.ts',
    'hooks/session-start': 'src/hooks/session-start.ts',
    'hooks/stop': 'src/hooks/stop.ts',
    'mcp/search-server': 'src/mcp/search-server.ts',
  },
  external: ['better-sqlite3', 'sqlite-vec-darwin-arm64', 'sqlite-vec-darwin-x64', 'sqlite-vec-linux-arm64', 'sqlite-vec-linux-x64'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'node20',
});
