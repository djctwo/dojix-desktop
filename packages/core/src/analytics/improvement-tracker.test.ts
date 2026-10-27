import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { DojixTrade } from "../model/trade";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeImprovementTracker, improvementTrackerComponent, improvementTrackerParity } from "./improvement-tracker";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const BASE = Date.UTC(2026, 0, 5);

/** Ascending trades from (profit, R) rows, returned in repository order. */
function rows(spec: readonly [string, number][]): DojixTrade[] {
  return spec.map(([p, r], i) => fxTrade({ netProfit: p, rMultiple: r, closeTime: BASE + i * 60_000 })).reverse();
}

const losses = (n: number): [string, number][] => Array.from({ length: n }, () => ["-10", -1] as [string, number]);
const wins = (n: number): [string, number][] => Array.from({ length: n }, () => ["20", 2] as [string, number]);

describe("ImprovementTracker", () => {
  it("is empty and insufficient below 20 trades", () => {
    const m = computeImprovementTracker(rows([...losses(10), ...wins(9)]));
    expect(m.rollingMetrics).toEqual([]);
    expect(m.trend).toBe("insufficient");
    expect(m.insightText).toBe("Keep trading to build enough history for trend detection");
  });

  it("rolls windows of max(10, n/10) and detects improvement", () => {
    const m = computeImprovementTracker(rows([...losses(10), ...wins(10)]));
    expect(m.rollingMetrics).toHaveLength(11);
    expect(m.rollingMetrics[0]).toEqual({ id: 9, tradeNumber: 10, rollingWinRate: 0, rollingAvgR: -1, rollingPF: 0 });
    expect(m.rollingMetrics[5]).toMatchObject({ id: 14, rollingWinRate: 50, rollingAvgR: 0.5, rollingPF: 2 });
    expect(m.rollingMetrics[10]).toMatchObject({ tradeNumber: 20, rollingWinRate: 100, rollingAvgR: 2, rollingPF: 5 });
    expect(m.trend).toBe("improving");
    expect(m.insightText).toMatch(/improvement in both/);
  });

  it("detects decline and stability", () => {
    expect(computeImprovementTracker(rows([...wins(10), ...losses(10)])).trend).toBe("declining");
    const alt = Array.from({ length: 30 }, (_, i) => (i % 2 ? ["20", 2] : ["-10", -1]) as [string, number]);
    const m = computeImprovementTracker(rows(alt));
    expect(m.trend).toBe("stable");
    expect(m.insightText).toBe("Performance is consistent — maintain your current approach");
    // n = 200 → window 20
    expect(computeImprovementTracker(rows(Array.from({ length: 200 }, () => ["1", 0.1] as [string, number]))).rollingMetrics).toHaveLength(181);
  });

  it("needs both R and WR for 'improving'; WR alone falling 5+ is 'declining'", () => {
    // WR rises but R flat: R stays 0 for every trade.
    const flatR = [...losses(10).map(([p]) => [p, 0] as [string, number]), ...wins(10).map(([p]) => [p, 0] as [string, number])];
    expect(computeImprovementTracker(rows(flatR)).trend).toBe("stable");
    const falling = [...wins(10).map(([p]) => [p, 0] as [string, number]), ...losses(10).map(([p]) => [p, 0] as [string, number])];
    expect(computeImprovementTracker(rows(falling)).trend).toBe("declining");
  });

  it("caps PF at 5", () => {
    const m = computeImprovementTracker(rows([["-1", -1], ...wins(19).map(() => ["1000", 1] as [string, number])]));
    expect(m.rollingMetrics[0]?.rollingPF).toBe(5);
  });

  it("is registered for both brands and encodes the Trend enum", () => {
    const reg = new AnalyticsRegistry().register(improvementTrackerComponent);
    const st = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.list("greenwick", "behavioral").map((c) => c.id)).toEqual(["ImprovementTracker"]);
    const stTrades = Array.from({ length: 20 }, (_, i) => stTrade({ netProfit: "5", rMultiple: 1, closeTime: BASE + i * 60_000 }));
    expect(reg.run("ImprovementTracker", st, stTrades)).toMatchObject({ trend: "stable" });
    const model = improvementTrackerParity.compute(fx, rows([...losses(10), ...wins(10)]), undefined);
    if (!model) throw new Error("model");
    expect(improvementTrackerParity.members.trend?.(model, fx)).toEqual({
      $case: "improving",
      label: "Improving",
      icon: "arrow.up.right.circle.fill",
    });
    expect((improvementTrackerParity.members.rollingMetrics?.(model, fx) as unknown[])[0]).toEqual({
      id: 9,
      tradeNumber: 10,
      rollingWinRate: 0,
      rollingAvgR: -1,
      rollingPF: 0,
    });
    expect(improvementTrackerParity.members.insightText?.(model, fx)).toBe(model.insightText);
  });

  it("never yields NaN for valid input (property)", () => {
    const money = fc.integer({ min: -1e8, max: 1e8 }).map((c) => String(c / 100));
    const r = fc.double({ min: -1e6, max: 1e6, noNaN: true });
    fc.assert(
      fc.property(fc.array(fc.tuple(money, r), { maxLength: 60 }), (spec) => {
        const m = computeImprovementTracker(rows(spec));
        for (const p of m.rollingMetrics) {
          for (const v of [p.rollingWinRate, p.rollingAvgR, p.rollingPF]) expect(Number.isFinite(v)).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});
