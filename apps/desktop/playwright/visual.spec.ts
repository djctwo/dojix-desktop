import { expect, test } from "@playwright/test";
import { BRAND, brandOf, open, settled } from "./support";

// One baseline per screen skeleton and gate, Windows Chromium only (fonts are bundled, the clock
// and zone are fixed, motion is reduced). Update with the ui.yml "update_snapshots" run.
test.skip(process.platform !== "win32", "visual baselines are recorded on Windows Chromium");

test("screens", async ({ page }, info) => {
  const brand = BRAND[brandOf(info)];
  await open(page);
  for (const screen of [...brand.screens, "help"]) {
    await page.getByTestId(`nav-${screen}`).click();
    await settled(page);
    await expect(page).toHaveScreenshot(`${screen}.png`);
  }
});

test("analytics tabs", async ({ page }) => {
  await open(page, "#/analytics/timing");
  for (const tab of ["timing", "sessions", "pairs", "risk", "behavioral", "advanced"]) {
    await page.getByTestId(`analytics-tab-${tab}`).click();
    await settled(page);
    await expect(page).toHaveScreenshot(`analytics-${tab}.png`, { fullPage: true });
  }
});

for (const gate of ["locked", "setup", "olderCopy", "storageError"] as const) {
  test(`gate ${gate}`, async ({ page }) => {
    await open(page, "", { gate });
    await settled(page);
    await expect(page).toHaveScreenshot(`gate-${gate}.png`);
  });
}

test("empty journal", async ({ page }) => {
  await open(page, "", { fixture: "empty" });
  await settled(page);
  await expect(page).toHaveScreenshot("journal-empty.png");
  await page.getByTestId("nav-dashboard").click();
  await settled(page);
  await expect(page).toHaveScreenshot("dashboard-empty.png");
});
