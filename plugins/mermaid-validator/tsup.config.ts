import { defineConfig } from 'tsup';

export default defineConfig({
  banner: {
    js: "import * as __mermaidValidatorModule from 'node:module'; const require = __mermaidValidatorModule.createRequire(import.meta.url); try { __mermaidValidatorModule.enableCompileCache?.(); } catch {}",
  },
  clean: true,
  dts: false,
  entry: {
    'hooks/post-tool-use': 'src/hooks/post-tool-use.ts',
  },
  format: ['esm'],
  noExternal: ['dompurify', 'happy-dom', 'mermaid', 'zod'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: false,
  splitting: false,
  target: 'node20',
});
