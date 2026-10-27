import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import type { DojixTrade, Trade } from "../model/trade";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeConsistencyScore, consistencyScoreComponent, consistencyScoreParity } from "./consistency-score";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const st = createEngineContext({ brand: "greenwick", now: 0 });
const BASE = Date.UTC(2026, 0, 5);

function series(n: number, make: (i: number) => Partial<DojixTrade>): DojixTrade[] {
  return Array.from({ length: n }, (_, i) => fxTrade({ netProfit: "10", lots: 1, hour: 10, closeTime: BASE + i * 60_000, ...make(i) })).reverse();
}

const scores = (trades: readonly Trade[], ctx = fx) => computeConsistencyScore(ctx, trades).dimensions.map((d) => d.score);

describe("ConsistencyScore", () => {
  it("is empty below 10 trades (score 0, grade F)", () => {
    const m = computeConsistencyScore(fx, series(9, () => ({})));
    expect(m).toEqual({ dimensions: [], overallScore: 0, grade: "f", gradeLabel: "F", focusArea: null });
  });

  it("scores a perfectly regular history 100 / A", () => {
    const m = computeConsistencyScore(fx, series(10, () => ({})));
    expect(m.dimensions).toEqual([
      { name: "Win Rate", score: 100, detail: "Stable win rate" },
      { name: "P/F Stability", score: 100, detail: "Consistent profitability" },
      { name: "Recovery", score: 100, detail: "No drawdowns" },
      { name: "Sizing", score: 100, detail: "Consistent position sizing" },
      // (1 − 1/24) × 120 = 115 → min(100, …)
      { name: "Timing", score: 100, detail: "Focused trading hours" },
    ]);
    expect(m.overallScore).toBe(100);
    expect(m.grade).toBe("a");
    expect(m.focusArea).toBeNull();
  });

  it("scores an all-loss history 40 / D", () => {
    const m = computeConsistencyScore(fx, series(10, () => ({ netProfit: "-10" })));
    expect(m.dimensions).toEqual([
      { name: "Win Rate", score: 0, detail: "Win rate varies significantly between periods" }, // μ = 0 → cv = 1
      { name: "P/F Stability", score: 0, detail: "No profitable periods" },
      // one stretch of 10 under water: 100 − 10/10·200 − 20 → 0
      { name: "Recovery", score: 0, detail: "Avg 10 trades to recover from drawdowns" },
      { name: "Sizing", score: 100, detail: "Consistent position sizing" },
      { name: "Timing", score: 100, detail: "Focused trading hours" },
    ]);
    expect(m.overallScore).toBe(40);
    expect(m.grade).toBe("d");
    expect(m.gradeLabel).toBe("D");
    expect(m.focusArea?.name).toBe("Win Rate"); // the first of equal minima
  });

  it("computes the win-rate CV over windows of max(5, n/4)", () => {
    // W L W L … over 10 trades: windows of 5 alternate 3/5 and 2/5.
    const m = computeConsistencyScore(fx, series(10, (i) => ({ netProfit: i % 2 === 0 ? "10" : "-10" })));
    const rates = [0.6, 0.4, 0.6, 0.4, 0.6, 0.4];
    const mean = rates.reduce((a, b) => a + b, 0) / 6;
    const sd = Math.sqrt(rates.map((r) => (r - mean) * (r - mean)).reduce((a, b) => a + b, 0) / 6);
    expect(m.dimensions[0]?.score).toBe(Math.max(0, Math.min(100, (1 - sd / mean) * 100)));
    expect(m.dimensions[0]?.detail).toBe("Stable win rate");
  });

  it("compares the profit factors of the two halves", () => {
    // First half: +30/−10 = PF 3; second half: +10/−10 = PF 1 → ratio 1/3.
    const p = ["10", "10", "10", "-10", "1", "10", "-10", "1", "1", "-1"];
    // halves of 5: [10,10,10,−10,1] PF 31/10; [10,−10,1,1,−1] PF 12/11
    const m = computeConsistencyScore(fx, series(10, (i) => ({ netProfit: p[i] as string })));
    const ratio = 12 / 11 / (31 / 10);
    expect(m.dimensions[1]?.score).toBeCloseTo(ratio * 100, 12);
    expect(m.dimensions[1]?.detail).toBe("Profit factor differs significantly between halves");
    // A half with wins and no losses counts as PF 10.
    const one = computeConsistencyScore(fx, series(10, (i) => ({ netProfit: i < 5 ? "1" : i === 5 ? "-1" : "1" })));
    expect(one.dimensions[1]?.score).toBeCloseTo((4 / 1 / 10) * 100, 12);
  });

  it("measures underwater stretches and the long-stretch penalty", () => {
    // +10, −1 ×3 (stretch 3), +20 (new peak 27), −1 −1 +1 (stretch 3, back to 27 resets: `>=`), +1
    const p = ["10", "-1", "-1", "-1", "20", "-1", "-1", "1", "1", "1"];
    const m = computeConsistencyScore(fx, series(10, (i) => ({ netProfit: p[i] as string })));
    // avg 3, max 3 ≤ 10/3 → 100 − 3/10·200 = 40
    expect(m.dimensions[2]).toEqual({ name: "Recovery", score: 40, detail: "Quick recovery from drawdowns" });
    // Stretches [3, 4]: max 4 > 10/3 → 100 − 70 − 20 = 10
    const p2 = ["10", "-1", "-1", "-1", "20", "-1", "-1", "-1", "2", "1"];
    expect(computeConsistencyScore(fx, series(10, (i) => ({ netProfit: p2[i] as string }))).dimensions[2]?.score).toBeCloseTo(10, 12);
    const q = ["10", "-1", "20", "-1", "30", "1", "1", "1", "1", "1"];
    const r = computeConsistencyScore(fx, series(10, (i) => ({ netProfit: q[i] as string })));
    expect(r.dimensions[2]?.score).toBe(100 - 0.1 * 200); // stretches [1, 1]
  });

  it("measures size CV and timing concentration; shares for Greenwick", () => {
    const sizes = computeConsistencyScore(fx, series(10, (i) => ({ lots: i % 2 ? 1 : 3, hour: i })));
    expect(sizes.dimensions[3]).toEqual({ name: "Sizing", score: 50, detail: "Consistent position sizing" }); // cv 0.5
    expect(sizes.dimensions[4]?.score).toBeCloseTo((1 - 10 / 24) * 120, 12);
    expect(sizes.dimensions[4]?.detail).toBe("Trading across too many hours — pick a session");
    const wide = computeConsistencyScore(fx, series(10, (i) => ({ lots: i === 0 ? 100 : 1 })));
    expect(wide.dimensions[3]).toMatchObject({ score: 0, detail: "Lot sizes vary widely — sign of revenge trading" });
    expect(computeConsistencyScore(fx, series(10, () => ({ lots: 0 }))).dimensions[3]).toEqual({
      name: "Sizing",
      score: 50,
      detail: "No sizing data",
    });
    const stWide = Array.from({ length: 10 }, (_, i) => stTrade({ netProfit: "1", shares: i === 0 ? 10_000 : 1, closeTime: BASE + i * 60_000 }));
    expect(computeConsistencyScore(st, stWide).dimensions[3]?.detail).toBe("Position sizes vary widely — sign of revenge trading");
  });

  it("grades B and C bands", () => {
    // Sizing 0 (one huge lot), the rest 100: overall 80 → B.
    const b = computeConsistencyScore(fx, series(10, (i) => ({ lots: i === 0 ? 100 : 1 })));
    expect(b.overallScore).toBe(80);
    expect(b.grade).toBe("b");
    expect(b.focusArea?.name).toBe("Sizing");
    // + 24 distinct hours: timing 0 → overall 60 → C
    const hours = Array.from({ length: 24 }, (_, i) => fxTrade({ netProfit: "10", lots: i === 0 ? 1000 : 1, hour: i, closeTime: BASE + i * 60_000 }));
    const c = computeConsistencyScore(fx, hours);
    expect(scores(hours)).toEqual([100, 100, 100, expect.any(Number), 0]);
    expect(c.grade).toBe("c");
  });

  it("is registered for both brands and encodes Grade as {$case, label}", () => {
    const reg = new AnalyticsRegistry().register(consistencyScoreComponent);
    expect(reg.list("dojix", "behavioral").map((x) => x.id)).toEqual(["ConsistencyScore"]);
    expect(reg.run("ConsistencyScore", fx, series(9, () => ({})))).toBeNull();
    const m = consistencyScoreParity.compute(fx, series(10, () => ({})), undefined);
    if (!m) throw new Error("model");
    expect(consistencyScoreParity.members.grade?.(m, fx)).toEqual({ $case: "a", label: "A" });
    expect(consistencyScoreParity.members.overallScore?.(m, fx)).toBe(100);
    expect((consistencyScoreParity.members.dimensions?.(m, fx) as unknown[])[0]).toEqual({ name: "Win Rate", score: 100, detail: "Stable win rate" });
  });

  it("stays within 0–100 for valid input (property)", () => {
    const money = fc.integer({ min: -1e8, max: 1e8 }).map((c) => String(c / 100));
    const row = fc.record({ p: money, lots: fc.double({ min: 0, max: 1e6, noNaN: true }), hour: fc.integer({ min: 0, max: 23 }) });
    fc.assert(
      fc.property(fc.array(row, { minLength: 10, maxLength: 50 }), fc.boolean(), (rs, greenwick) => {
        const trades: Trade[] = rs.map((r, i) =>
          greenwick
            ? stTrade({ netProfit: r.p, shares: r.lots, hour: r.hour, closeTime: BASE + i * 60_000 })
            : fxTrade({ netProfit: r.p, lots: r.lots, hour: r.hour, closeTime: BASE + i * 60_000 }),
        );
        const m = computeConsistencyScore(greenwick ? st : fx, trades);
        expect(m.overallScore >= 0 && m.overallScore <= 100).toBe(true);
        for (const d of m.dimensions) expect(d.score >= 0 && d.score <= 100).toBe(true);
      }),
      { numRuns: 150 },
    );
    // NaN sizes: Swift's guard `mean > 0` fails → 50.
    expect(computeConsistencyScore(fx, series(10, () => ({ lots: NaN }))).dimensions[3]?.score).toBe(50);
  });
});
