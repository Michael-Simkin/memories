import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

const tsFiles = ['**/*.ts', '**/*.tsx'];
const configDirectory = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/web/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  {
    files: tsFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          path.join(configDirectory, 'plugins/memories/tsconfig.json'),
          path.join(configDirectory, 'plugins/memories/tsconfig.test.json'),
          path.join(configDirectory, 'plugins/memories/web/tsconfig.json'),
        ],
        tsconfigRootDir: configDirectory,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'import-x': importX,
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': ['error', { count: 1 }],
      'no-console': 'error',
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'simple-import-sort/imports': 'error',
      'unused-imports/no-unused-imports': 'error',
    },
  },
  {
    files: [
      'plugins/memories/src/shared/logger.ts',
      'plugins/memories/src/engine/main.ts',
      'plugins/memories/src/engine/ensure-engine.ts',
      'plugins/memories/src/extraction/run.ts',
      'plugins/memories/src/mcp/search-server.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
);
