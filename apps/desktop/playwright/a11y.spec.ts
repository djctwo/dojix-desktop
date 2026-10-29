import { expect, test } from "@playwright/test";
import { BRAND, brandOf, open, seriousViolations, settled } from "./support";

// axe-core over every screen and gate: zero serious or critical WCAG 2.x A/AA issues.

test("every screen has no serious or critical accessibility issue", async ({ page }, info) => {
  const brand = BRAND[brandOf(info)];
  await open(page);
  for (const screen of [...brand.screens, "help"]) {
    await page.getByTestId(`nav-${screen}`).click();
    await settled(page);
    expect(await seriousViolations(page), `${screen}`).toEqual([]);
  }
  await page.getByTestId("nav-analytics").click();
  for (const tab of ["sessions", "pairs", "risk", "behavioral", "advanced"]) {
    await page.getByTestId(`analytics-tab-${tab}`).click();
    await settled(page);
    expect(await seriousViolations(page), `analytics/${tab}`).toEqual([]);
  }
});

for (const gate of ["locked", "setup", "olderCopy", "storageError"] as const) {
  test(`the ${gate} gate has no serious or critical accessibility issue`, async ({ page }) => {
    await open(page, "", { gate });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test("empty journal screens have no serious or critical accessibility issue", async ({ page }) => {
  await open(page, "", { fixture: "empty" });
  for (const screen of ["journal", "dashboard", "analytics"]) {
    await page.getByTestId(`nav-${screen}`).click();
    await settled(page);
    expect(await seriousViolations(page), screen).toEqual([]);
  }
});

test("keyboard: skip link, sidebar and tabs are reachable without a mouse", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("journal-table")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("nav-journal")).toBeFocused();
  await page.getByTestId("nav-analytics").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("analytics-tab-timing").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("analytics-tab-sessions")).toBeFocused();
  await expect(page.getByTestId("analytics-tab-sessions")).toHaveAttribute("aria-selected", "true");
});
