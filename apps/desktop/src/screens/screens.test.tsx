import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { asCurrency, calculateMetrics, toEngineTrade } from "@dojix-desktop/core";
import { renderApp } from "../test-support/render";
import { AnalyticsScreen } from "./AnalyticsScreen";
import { DashboardScreen } from "./DashboardScreen";
import { EdgeReportScreen } from "./EdgeReportScreen";
import { HelpScreen } from "./HelpScreen";
import { PlannedScreen } from "./placeholders";
import { AnalyticsTab } from "../analytics/AnalyticsTab";
import { AnalyticsViewRegistry } from "@dojix-desktop/ui";

beforeEach(() => history.replaceState(null, "", "#"));
afterEach(cleanup);

describe("Dashboard", () => {
  it("shows the MetricsCalculator headline numbers and the Overview cards", async () => {
    const { trades, brand } = await renderApp({ screen: (b) => <DashboardScreen brand={b} /> });
    const metrics = calculateMetrics(trades.map((t) => toEngineTrade(t, "dojix")), { brand: "dojix", compat: "fixed" });
    await waitFor(() => expect(screen.getByTestId("metric-net").textContent).toContain(asCurrency(metrics.totalProfit, "en_US")));
    expect(screen.getByTestId("metric-trades").textContent).toContain("5");
    expect(brand.id).toBe("dojix");
    await waitFor(() => expect(screen.getByTestId("analytics-overview")).toBeTruthy());
    expect(screen.getByTestId("dashboard-propfirm")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("dashboard-mode")).getByRole("radio", { name: "Essential" }));
    expect(screen.queryByTestId("dashboard-propfirm")).toBeNull();
  });

  it("empty journal: an empty state that leads to Import", async () => {
    await renderApp({ fixture: "empty", screen: (b) => <DashboardScreen brand={b} /> });
    await waitFor(() => expect(screen.getByTestId("dashboard-empty")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Import trades" }));
    expect(location.hash).toBe("#/import");
  });

  it("a trades failure shows the error state", async () => {
    await renderApp({ fail: ["journal_trades"], screen: (b) => <DashboardScreen brand={b} /> });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("told to fail journal_trades"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
});

describe("Analytics", () => {
  it("switches tabs and renders the registry cards with the example view", async () => {
    await renderApp({ brand: "greenwick", fixture: "f2", screen: (b) => <AnalyticsScreen brand={b} /> });
    await waitFor(() => expect(screen.getByTestId("analytics-timing")).toBeTruthy());
    expect(screen.getByTestId("analytics-card-HourlyPnLChart").dataset["status"]).toBe("ok");
    expect(screen.getByRole("img", { name: /P&L by hour \(ET\)/ })).toBeTruthy();
    expect(screen.getByTestId("analytics-card-GapAnalysis")).toBeTruthy();
    fireEvent.click(screen.getByTestId("analytics-tab-pairs"));
    expect(screen.getByTestId("analytics-tab-pairs").textContent).toBe("Symbols");
    await waitFor(() => expect(screen.getByTestId("analytics-pairs")).toBeTruthy());
    expect(screen.getByTestId("analytics-card-SectorExposure")).toBeTruthy();
    expect(screen.queryByTestId("analytics-pairs")?.querySelector('[data-status="error"]')).toBeNull();
  });

  it("a tab without components says so", async () => {
    await renderApp({
      screen: (b) => <AnalyticsTab brand={b} placement="pulse" label="x" views={new AnalyticsViewRegistry()} />,
      brand: "greenwick",
    });
    await waitFor(() => expect(screen.getByTestId("analytics-pulse-none")).toBeTruthy());
  });

  it("errors when the trades can't be read", async () => {
    await renderApp({ fail: ["journal_trades"], screen: (b) => <AnalyticsTab brand={b} placement="timing" label="Timing" /> });
    await waitFor(() => expect(screen.getByTestId("analytics-timing-error")).toBeTruthy());
  });
});

describe("other screens", () => {
  it("Edge Report lists its registry cards", async () => {
    await renderApp({ fixture: "f2", screen: (b) => <EdgeReportScreen brand={b} /> });
    await waitFor(() => expect(screen.getByTestId("analytics-edgeReport")).toBeTruthy());
    expect(screen.getByTestId("analytics-card-TagAnalytics")).toBeTruthy();
  });

  it("Help lists every shortcut and the version", async () => {
    await renderApp({ screen: (b) => <HelpScreen brand={b} version="1.2.3" /> });
    const rows = within(screen.getByTestId("shortcut-table")).getAllByRole("row");
    expect(rows.length).toBe(1 + 18);
    expect(screen.getByText(/version 1\.2\.3/)).toBeTruthy();
    cleanup();
    await renderApp({ screen: (b) => <HelpScreen brand={b} version={null} /> });
    expect(screen.queryByText(/version/)).toBeNull();
  });

  it("planned screens name their team", async () => {
    await renderApp({ brand: "greenwick", screen: (b) => <PlannedScreen brand={b} screen="browse" /> });
    expect(screen.getByTestId("screen-title").textContent).toBe("Browse");
    expect(screen.getByTestId("screen-placeholder").textContent).toContain("ui-brand");
  });
});
