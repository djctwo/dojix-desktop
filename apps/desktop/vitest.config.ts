import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test-support/**",
        // Entry points and the worker shell: exercised by the Playwright specs, not by jsdom.
        "src/main.tsx",
        "src/brand.ts",
        "src/analytics/analytics.worker.ts",
        "src/mock/start.ts",
        "src/vite-env.d.ts",
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
