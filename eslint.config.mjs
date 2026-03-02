import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

const tsFiles = ['**/*.ts', '**/*.tsx'];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/web/dist/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  {
    files: tsFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
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
    files: ['plugins/memories/src/shared/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
);
