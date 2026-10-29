import { defineConfig, devices } from "@playwright/test";

// Fast UI specs against the Vite mock builds (no Tauri, no Rust): `pnpm build:mock:dojix`,
// `pnpm build:mock:greenwick`, then `pnpm test:ui`. Fictional fixtures only (mock/fixtures.ts).
// Visual baselines are Windows Chromium only (playwright/__screenshots__/win32/); see docs/UI.md.

const BRANDS = [
  { name: "dojix", port: 4173 },
  { name: "greenwick", port: 4174 },
] as const;

export default defineConfig({
  testDir: "./playwright",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  timeout: 45_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide", scale: "css" },
  },
  use: {
    ...devices["Desktop Chrome"],
    // The default window of SPEC 2.1.
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: "UTC",
    locale: "en-US",
    colorScheme: "dark",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: BRANDS.map((b) => ({ name: b.name, use: { baseURL: `http://127.0.0.1:${b.port}` } })),
  webServer: BRANDS.map((b) => ({
    command: `pnpm exec vite preview --mode ${b.name}-mock --host 127.0.0.1`,
    url: `http://127.0.0.1:${b.port}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  })),
});
