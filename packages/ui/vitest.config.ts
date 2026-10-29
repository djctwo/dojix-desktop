import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // components/: the security-core screens of Phase 1S (lock, older copy, settings), tested by
      // security.test.tsx and the real-binary e2e; the threshold covers the design system.
      exclude: ["src/**/*.test.{ts,tsx}", "src/test-support/**", "src/components/**"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
  },
});
