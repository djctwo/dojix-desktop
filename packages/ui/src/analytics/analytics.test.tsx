import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ALL_BRANDS } from "@dojix-desktop/brands";
import { AnalyticsCard, AnalyticsGrid, FallbackView } from "./AnalyticsCard";
import { AnalyticsViewRegistry, defineAnalyticsView, humanizeComponentId, type AnalyticsViewProps } from "./types";

afterEach(cleanup);

const brand = ALL_BRANDS.dojix;

function Big({ model }: AnalyticsViewProps<{ total: number }>) {
  return <p data-testid="view">total {model.total}</p>;
}

function Broken(): never {
  throw new Error("view bug");
}

const views = new AnalyticsViewRegistry()
  .register(defineAnalyticsView({ id: "Big", title: "Big Card", help: "Explains it.", view: Big, span: 2, emptyMessage: "Import more." }))
  .register(defineAnalyticsView({ id: "Broken", title: "Broken", view: Broken, span: "full" }));

describe("AnalyticsViewRegistry", () => {
  it("refuses duplicates and lists ids", () => {
    expect(views.ids()).toEqual(["Big", "Broken"]);
    expect(views.has("Big")).toBe(true);
    expect(() => views.register(defineAnalyticsView({ id: "Big", title: "x", view: Big }))).toThrow(/twice/);
  });

  it("humanizes component ids", () => {
    expect(humanizeComponentId("WinLossDistribution")).toBe("Win Loss Distribution");
    expect(humanizeComponentId("HourlyPnLChart")).toBe("Hourly P&L Chart");
    expect(humanizeComponentId("MAEMFEChart")).toBe("MAE MFE Chart");
    expect(humanizeComponentId("TimeToMFEAnalysis")).toBe("Time To MFE Analysis");
  });
});

describe("AnalyticsCard", () => {
  const props = { brand, tradeCount: 12, locale: "en_US" };

  it("draws the view with its model and the help button", () => {
    render(<AnalyticsCard componentId="Big" view={views.get("Big")} result={{ status: "ok", model: { total: 5 } }} {...props} />);
    const card = screen.getByTestId("analytics-card-Big");
    expect(card.dataset["status"]).toBe("ok");
    expect(card.className).toContain("span-2");
    expect(screen.getByRole("heading", { name: "Big Card" }).tagName).toBe("H2");
    expect(screen.getByTestId("view").textContent).toBe("total 5");
    expect(screen.getByRole("button", { name: "What is Big Card?" })).toBeTruthy();
  });

  it("shows loading, below-minimum, empty and error states", () => {
    const { rerender } = render(<AnalyticsCard componentId="Big" view={views.get("Big")} result={{ status: "loading" }} {...props} headingLevel={3} />);
    expect(screen.getByTestId("analytics-card-Big").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("heading", { name: "Big Card" }).tagName).toBe("H3");
    rerender(<AnalyticsCard componentId="Big" view={views.get("Big")} result={{ status: "belowMin", minTrades: 30, tradeCount: 12 }} {...props} />);
    expect(screen.getByText(/once you have 30 trades \(you have 12\)/)).toBeTruthy();
    rerender(<AnalyticsCard componentId="Big" view={views.get("Big")} result={{ status: "empty" }} {...props} />);
    expect(screen.getByText("Import more.")).toBeTruthy();
    rerender(<AnalyticsCard componentId="Big" view={views.get("Big")} result={{ status: "error", message: "boom" }} {...props} />);
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  it("contains a view that throws to its own card", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<AnalyticsCard componentId="Broken" view={views.get("Broken")} result={{ status: "ok", model: {} }} {...props} />);
    expect(screen.getByRole("alert").textContent).toContain("view bug");
    expect(screen.getByTestId("analytics-card-Broken").className).toContain("span-full");
    vi.restoreAllMocks();
  });

  it("falls back to a field preview without a view", () => {
    render(
      <AnalyticsCard
        componentId="PerformanceSummary"
        view={undefined}
        result={{ status: "ok", model: { winRate: 55.123, trades: 10, best: "EURUSD", flag: true, list: [1, 2], nested: { a: 1 }, inf: Infinity } }}
        {...props}
      />,
    );
    expect(screen.getByRole("heading", { name: "Performance Summary" })).toBeTruthy();
    const text = screen.getByTestId("analytics-fallback").textContent ?? "";
    expect(text).toContain("Win Rate55.12");
    expect(text).toContain("Trades10");
    expect(text).toContain("Flagyes");
    expect(text).toContain("List2 items");
    expect(text).toContain("InfInfinity");
    expect(text).not.toContain("Nested");
  });

  it("fallback handles scalars and long text", () => {
    const { rerender } = render(<FallbackView model={3} />);
    expect(screen.getByTestId("analytics-fallback").textContent).toBe("Value3");
    rerender(<FallbackView model={{ s: "x".repeat(60), off: false }} />);
    expect(screen.getByTestId("analytics-fallback").textContent).toContain("…");
    expect(screen.getByTestId("analytics-fallback").textContent).toContain("Offno");
    rerender(<FallbackView model={null} />);
    expect(screen.getByTestId("analytics-fallback").textContent).toBe("Value—");
  });
});

describe("AnalyticsGrid", () => {
  it("renders one card per item, labelled as a group", () => {
    render(
      <AnalyticsGrid
        items={[
          { id: "Big", result: { status: "ok", model: { total: 1 } } },
          { id: "Other", result: { status: "empty" } },
        ]}
        views={views}
        brand={brand}
        tradeCount={1}
        locale="en_US"
        label="Timing analytics"
        testId="grid"
        headingLevel={3}
      />,
    );
    expect(screen.getByRole("group", { name: "Timing analytics" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });
});
