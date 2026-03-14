import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/coverage/**", "**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["plugins/memories/src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-nested-ternary": "error",
    },
  },
  {
    files: ["plugins/memories/src/**/services/**/*.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["plugins/memories/src/**/repositories/**/*.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["plugins/memories/src/storage/sqlite-service.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["plugins/memories/src/**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
);
