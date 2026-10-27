import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/test-support/**"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
