import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

/** Fixed "now" for every spec: just after the F2 fixtures end, so date filters are stable. */
export const NOW = "2026-09-30T12:00:00Z";
export const PASSWORD = "fictional-pass-1";

export type BrandName = "dojix" | "greenwick";

export const BRAND = {
  dojix: {
    productName: "Dojix",
    screens: ["journal", "dashboard", "analytics", "edgeReport", "pulse", "import", "settings"],
    numbered: ["journal", "dashboard", "analytics", "edgeReport", "pulse", "import"],
  },
  greenwick: {
    productName: "Greenwick",
    screens: ["journal", "dashboard", "analytics", "browse", "watchlist", "edgeReport", "import", "settings"],
    numbered: ["journal", "dashboard", "analytics", "edgeReport", "import"],
  },
} as const;

export const LABELS: Record<string, string> = {
  journal: "Journal",
  dashboard: "Dashboard",
  analytics: "Analytics",
  edgeReport: "Edge Report",
  pulse: "Pulse",
  browse: "Browse",
  watchlist: "Watchlist",
  import: "Import",
  settings: "Settings",
  help: "Help",
};

export function brandOf(info: TestInfo): BrandName {
  return info.project.name as BrandName;
}

/** Opens the mock app. `query` adds mock options (fixture, gate, latency, fail). */
export async function open(page: Page, hash = "", query: Record<string, string> = {}): Promise<void> {
  const params = new URLSearchParams({ now: NOW, ...query });
  await page.goto(`/?${params.toString()}${hash}`);
  await expect(page.locator("html[data-mock='true']")).toHaveCount(1);
}

/** Waits until fonts are in and no card, tab or screen is still computing. */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('[data-status="loading"]')).toHaveCount(0);
}

/** WCAG 2.x A/AA rules; returns the serious and critical violations (must be none). */
export async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
}

const SCREENS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "e2e-output", "ui", "screens");

/** A plain screenshot for the CI artifact (every platform), next to the visual baselines. */
export async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  mkdirSync(SCREENS_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENS_DIR, `${process.platform}-${info.project.name}-${name}.png`) });
}
