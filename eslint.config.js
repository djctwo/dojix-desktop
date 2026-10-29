import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/dist-mock/**", "**/playwright-report/**", "**/test-results/**", "target/**", "apps/desktop/src-tauri/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["**/*.{js,mjs}", "**/*.config.ts", "**/*.test.{ts,tsx}", "brands/**/*.ts", "tools/**", "apps/desktop/playwright/**"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["apps/desktop/e2e/**", "tools/**"],
    rules: { "no-console": "off" },
  },
);
