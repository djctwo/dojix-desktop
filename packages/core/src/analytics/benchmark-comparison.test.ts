import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { calculateMetrics, EMPTY_METRICS, type PortfolioMetrics } from "../metrics/metrics-calculator";
import { fxSeries, stTrade } from "../test-support/trades";
import { benchmarkComparisonComponent, benchmarkComparisonParity, computeBenchmarkComparison } from "./benchmark-comparison";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0 });
const metrics = (over: Partial<PortfolioMetrics>): PortfolioMetrics => ({ ...EMPTY_METRICS, totalTrades: 10, ...over });

describe("BenchmarkComparison", () => {
  it("needs 10 trades", () => {
    expect(computeBenchmarkComparison(fx, fxSeries(Array(9).fill("1")))).toEqual({ comparisons: [], aboveCount: 0 });
    const reg = new AnalyticsRegistry().register(benchmarkComparisonComponent);
    expect(reg.run("BenchmarkComparison", fx, fxSeries(Array(9).fill("1")))).toBeNull();
    expect(reg.list("dojix", "advanced").map((c) => c.id)).toEqual(["BenchmarkComparison"]);
    expect(reg.run("BenchmarkComparison", fx, fxSeries(Array(10).fill("1")))).toMatchObject({ aboveCount: 4 });
  });

  it("60% win rate is above the 45% benchmark (AnalyticsComponentTests.swift:483-492)", () => {
    const m = computeBenchmarkComparison(fx, [], { metrics: metrics({ winRate: 60 }) });
    expect(m.comparisons[0]).toEqual({ metric: "Win Rate", yours: "60.0%", benchmark: "45.0%", status: "above" });
  });

  it("uses a ±10% band with strict edges", () => {
    const wr = (winRate: number) => computeBenchmarkComparison(fx, [], { metrics: metrics({ winRate }) }).comparisons[0]?.status;
    expect(wr(49.5)).toBe("at"); // diff 4.5 = threshold, not above
    expect(wr(49.6)).toBe("above");
    expect(wr(40.5)).toBe("at");
    expect(wr(40.4)).toBe("below");
    // Lower is better for drawdown: DD% = maxDD / max(|total|, 1) × 100 vs 30.
    const dd = (maxDrawdown: number, totalProfit: number) =>
      computeBenchmarkComparison(fx, [], { metrics: metrics({ maxDrawdown, totalProfit }) }).comparisons[4];
    expect(dd(10, 100)).toEqual({ metric: "Max Drawdown %", yours: "10%", benchmark: "30%", status: "above" });
    expect(dd(50, 100)?.status).toBe("below");
    expect(dd(30, 100)?.status).toBe("at");
    expect(dd(0.5, 0)?.yours).toBe("50%"); // max(|0|, 1) = 1
  });

  it("formats each row like the Mac (∞ PF prints inf and is above)", () => {
    const m = computeBenchmarkComparison(fx, [], {
      metrics: metrics({ winRate: 45, profitFactor: Infinity, averageRMultiple: 0.125, sharpeRatio: -0.5, maxDrawdown: 0, totalProfit: 5 }),
    });
    expect(m.comparisons.map((c) => [c.metric, c.yours, c.benchmark, c.status])).toEqual([
      ["Win Rate", "45.0%", "45.0%", "at"],
      ["Profit Factor", "inf", "1.30", "above"],
      ["Avg R-Multiple", "0.12R", "0.30R", "below"],
      ["Sharpe Ratio", "-0.50", "0.50", "below"],
      ["Max Drawdown %", "0%", "30%", "above"],
    ]);
    expect(m.aboveCount).toBe(2);
  });

  it("computes the metrics itself for both brands", () => {
    const trades = fxSeries(["100", "50", "-30", "-20", "80", "10", "10", "10", "-5", "0"]);
    const m = computeBenchmarkComparison(fx, trades);
    const direct = computeBenchmarkComparison(fx, [], { metrics: calculateMetrics(trades, fx) });
    expect(m).toEqual(direct);
    expect(m.comparisons[0]?.yours).toBe("60.0%");
    const stTrades = Array.from({ length: 10 }, (_, i) => stTrade({ netProfit: i % 2 ? "5" : "-5", closeTime: Date.UTC(2026, 9, 20, 15, i) }));
    expect(computeBenchmarkComparison(st, stTrades).comparisons[0]?.yours).toBe("50.0%");
  });

  it("encodes the tuples and Status (with its icon) like the harness", () => {
    const trades = fxSeries(Array(10).fill("1"));
    const m = benchmarkComparisonParity.compute(fx, trades, undefined);
    const ref = m && (benchmarkComparisonParity.members.comparisons?.(m, fx) as unknown[]);
    expect(ref?.[0]).toEqual({ benchmark: "45.0%", metric: "Win Rate", status: { $case: "above", icon: "chevron.up.circle.fill" }, yours: "100.0%" });
    expect(ref?.[3]).toEqual({ benchmark: "0.50", metric: "Sharpe Ratio", status: { $case: "below", icon: "chevron.down.circle.fill" }, yours: "0.00" });
  });

  it("never throws and always yields five rows from ≥ 10 trades", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 10, maxLength: 30 }), (cents) => {
        const m = computeBenchmarkComparison(fx, fxSeries(cents.map((c) => String(c / 100))));
        expect(m.comparisons).toHaveLength(5);
        for (const c of m.comparisons) expect(c.yours).not.toContain("nan");
      }),
      { numRuns: 100 },
    );
  });
});
