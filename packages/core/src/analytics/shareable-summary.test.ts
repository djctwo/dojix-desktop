import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { EMPTY_METRICS } from "../metrics/metrics-calculator";
import { fxSeries, stTrade } from "../test-support/trades";
import { computeShareableSummary, shareableSummaryComponent, shareableSummaryParity, summaryTextOf } from "./shareable-summary";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0 });

describe("ShareableSummary", () => {
  it("renders the Mac template (F1 tiny set)", () => {
    // [100, 50, −30, −20, 80] ascending: total 180, 3W/2L, PF 230/50, expectancy 36, last = win.
    const text = computeShareableSummary(fx, fxSeries(["100", "50", "-30", "-20", "80"]).reverse()).summaryText;
    expect(text).toBe(
      [
        "📊 Dojix Daily Summary",
        "─────────────────────",
        "P&L: +$180.00 | 5 trades",
        "Win Rate: 60.0% (3W/2L)",
        "PF: 4.60 | Exp: $36.00",
        "Avg R: 1.00R | Sharpe: 0.69",
        "Streak: 🔥 1W",
        "─────────────────────",
        "via Dojix",
      ].join("\n"),
    );
  });

  it("shows losses, ❄️ streaks, ∞ PF as 99.99 and the Greenwick name", () => {
    const losing = summaryTextOf("greenwick", { ...EMPTY_METRICS, totalTrades: 2, losses: 2, totalProfit: -12.5, expectancy: -6.25, currentStreak: -2 });
    expect(losing.split("\n")).toEqual([
      "📊 Greenwick Daily Summary",
      "─────────────────────",
      "P&L: -$12.50 | 2 trades",
      "Win Rate: 0.0% (0W/2L)",
      "PF: 0.00 | Exp: -$6.25",
      "Avg R: 0.00R | Sharpe: 0.00",
      "Streak: ❄️ 2L",
      "─────────────────────",
      "via Greenwick",
    ]);
    const flat = summaryTextOf("dojix", { ...EMPTY_METRICS, totalTrades: 1, profitFactor: Infinity });
    expect(flat).toContain("P&L: +$0.00 | 1 trades");
    expect(flat).toContain("PF: 99.99");
    expect(flat).toContain("Streak: ➖ 0\n");
  });

  it("is empty without trades and wired into the registry", () => {
    expect(computeShareableSummary(fx, []).summaryText).toBe("");
    const reg = new AnalyticsRegistry().register(shareableSummaryComponent);
    expect(reg.run("ShareableSummary", st, [])).toBeNull();
    const m = reg.run("ShareableSummary", st, [stTrade({ netProfit: "1234.5" })]) as { summaryText: string };
    expect(m.summaryText).toContain("P&L: +$1,234.50 | 1 trades");
    const pm = shareableSummaryParity.compute(st, [stTrade({ netProfit: "1" })], undefined);
    expect(pm && shareableSummaryParity.members.summaryText?.(pm, st)).toMatch(/^📊 Greenwick Daily Summary\n/);
  });

  it("never throws and never prints nan for storage-valid trades", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -100_000_000, max: 100_000_000 }), { maxLength: 30 }), (cents) => {
        const text = computeShareableSummary(fx, fxSeries(cents.map((c) => String(c / 100)))).summaryText;
        expect(text.toLowerCase()).not.toContain("nan");
        expect(text === "" || text.split("\n").length === 9).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
