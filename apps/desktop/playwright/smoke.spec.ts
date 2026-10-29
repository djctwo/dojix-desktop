import { expect, test } from "@playwright/test";
import { BRAND, brandOf, capture, LABELS, open, PASSWORD, settled } from "./support";

test.describe("navigation", () => {
  test("opens on the Journal and every sidebar item shows its screen", async ({ page }, info) => {
    const brand = BRAND[brandOf(info)];
    await open(page);
    await expect(page.getByTestId("brand-name")).toHaveText(brand.productName);
    await expect(page.getByTestId("screen-title")).toHaveText("Journal");
    await expect(page.getByTestId("journal-table")).toBeVisible();
    await expect(page.getByTestId("db-status")).toHaveAttribute("data-encrypted", "true");
    for (const screen of brand.screens) {
      await page.getByTestId(`nav-${screen}`).click();
      await expect(page.getByTestId("screen-title")).toHaveText(LABELS[screen] as string);
      await expect(page.getByTestId(`nav-${screen}`)).toHaveAttribute("aria-current", "page");
      await settled(page);
      await capture(page, info, screen);
    }
    await page.getByTestId("nav-help").click();
    await expect(page.getByTestId("screen-title")).toHaveText("Help");
  });

  test("keyboard shortcuts follow SPEC 2.1", async ({ page }, info) => {
    const name = brandOf(info);
    const brand = BRAND[name];
    await open(page);
    await expect(page.getByTestId("journal-table")).toBeVisible();
    for (const [i, screen] of brand.numbered.entries()) {
      await page.keyboard.press(`Control+${i + 1}`);
      await expect(page.getByTestId("screen-title")).toHaveText(LABELS[screen] as string);
    }
    await page.keyboard.press("Control+,");
    await expect(page.getByTestId("screen-title")).toHaveText("Settings");
    await page.keyboard.press("F1");
    await expect(page.getByTestId("screen-title")).toHaveText("Help");
    await expect(page.getByTestId("shortcut-table")).toContainText("Ctrl+N");
    await page.keyboard.press("Control+3");
    await page.keyboard.press("Alt+4");
    await expect(page.getByTestId("analytics-tab-risk")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+n");
    await expect(page.getByTestId("screen-title")).toHaveText("Journal");
    if (name === "greenwick") {
      await page.keyboard.press("Control+i");
      await expect(page.getByTestId("screen-title")).toHaveText("Import");
    } else {
      await page.keyboard.press("Control+2");
      await expect(page.getByTestId("dashboard-mode").getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Control+Shift+E");
      await expect(page.getByTestId("dashboard-mode").getByRole("radio", { name: "Essential" })).toHaveAttribute("aria-checked", "true");
    }
  });
});

test.describe("analytics", () => {
  test("the dashboard and every analytics tab render registry cards from the worker", async ({ page }) => {
    await open(page, "#/dashboard");
    await expect(page.getByTestId("metric-trades")).toContainText(/\d+/);
    await expect(page.getByTestId("dashboard-overview").locator('[data-status="ok"]').first()).toBeVisible();
    await page.getByTestId("nav-analytics").click();
    for (const tab of ["timing", "sessions", "pairs", "risk", "behavioral", "advanced"]) {
      await page.getByTestId(`analytics-tab-${tab}`).click();
      await settled(page);
      const cards = page.getByTestId(`analytics-${tab}`).locator("[data-testid^='analytics-card-']");
      await expect(cards.first()).toBeVisible();
      await expect(page.getByTestId(`analytics-${tab}`).locator('[data-status="error"]')).toHaveCount(0);
    }
    await page.getByTestId("analytics-tab-timing").click();
    await expect(page.getByTestId("chart-hourly-pnl")).toBeVisible();
  });

  test("an empty journal shows the empty states", async ({ page }) => {
    await open(page, "", { fixture: "empty" });
    await expect(page.getByTestId("journal-empty")).toBeVisible();
    await page.getByTestId("nav-dashboard").click();
    await expect(page.getByTestId("dashboard-empty")).toBeVisible();
  });

  test("a failing trades command shows an error state with retry", async ({ page }) => {
    await open(page, "#/analytics/timing", { fail: "journal_trades" });
    await expect(page.getByTestId("analytics-timing-error")).toContainText("mock was told to fail");
  });
});

test.describe("launch gate", () => {
  test("locked: wrong password is refused, the right one opens the journal", async ({ page }) => {
    await open(page, "", { gate: "locked" });
    await expect(page.getByTestId("lock-screen")).toBeVisible();
    await expect(page.getByTestId("journal-table")).toHaveCount(0);
    await page.getByTestId("lock-password").fill("wrong-password");
    await page.getByTestId("lock-submit").click();
    await expect(page.getByTestId("lock-message")).toHaveText("Incorrect password (1/5)");
    await page.getByTestId("lock-password").fill(PASSWORD);
    await page.getByTestId("lock-submit").click();
    await expect(page.getByTestId("journal-table")).toBeVisible();
  });

  test("storage error shows the start-up error", async ({ page }) => {
    await open(page, "", { gate: "storageError" });
    await expect(page.getByTestId("startup-error")).toContainText("No system keyring");
  });
});
