import { describe, expect, it } from "vitest";

// The real app runs with Tauri's `freezePrototype` (Object.prototype frozen before any script).
// A library that breaks under it blanks the whole window, which only the real-binary e2e would
// otherwise notice. This file freezes it first, then starts the app and runs every analytics tab.
Object.freeze(Object.prototype);

describe("under a frozen Object.prototype", () => {
  it("the app starts on the Journal and the analytics screens render", async () => {
    const { renderApp } = await import("../test-support/render");
    const { screen, waitFor, fireEvent } = await import("@testing-library/react");
    await renderApp({ fixture: "f2" });
    await waitFor(() => expect(screen.getByTestId("journal-table")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-analytics"));
    await waitFor(() => expect(screen.getByTestId("analytics-timing")).toBeTruthy(), { timeout: 10_000 });
    expect(screen.getByRole("img", { name: /P&L by hour/ })).toBeTruthy();
    fireEvent.click(screen.getByTestId("nav-dashboard"));
    await waitFor(() => expect(screen.getByTestId("metric-net")).toBeTruthy(), { timeout: 10_000 });
  });

  it("the analytics engine computes every placement of both brands", async () => {
    const { AnalyticsEngine } = await import("../analytics/engine");
    const { loadFixture } = await import("../mock/fixtures");
    const { TEST_SETTINGS } = await import("../test-support/render");
    for (const brand of ["dojix", "greenwick"] as const) {
      const engine = new AnalyticsEngine();
      engine.load(1, brand, await loadFixture("f2", brand));
      for (const placement of ["overview", "timing", "sessions", "pairs", "risk", "behavioral", "advanced", "edgeReport"] as const) {
        const result = engine.run({ datasetId: 1, now: Date.parse("2026-09-30T12:00:00Z"), settings: TEST_SETTINGS, filter: {}, placement, metrics: true });
        expect(result.cards.filter((c) => c.result.status === "error"), `${brand}/${placement}`).toEqual([]);
      }
    }
  });
});
