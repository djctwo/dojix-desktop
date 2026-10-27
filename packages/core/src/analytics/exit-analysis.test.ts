import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeExitAnalysis, exitAnalysisComponent, exitAnalysisParity } from "./exit-analysis";

const fxSwift = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const fxFixed = createEngineContext({ brand: "dojix", now: 0, compat: "fixed" });
const stSwift = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });

// Efficiency = R × slDist / MFE × 100 with slDist 20 (fxTrade default) and MFE 20 → 100·R.
const eff = (e: number, p = "10", extra = {}) => fxTrade({ ticket: `e${e}`, netProfit: p, mfePips: 20, rMultiple: e / 100, ...extra });

describe("ExitAnalysis FX", () => {
  it("averages efficiency, sums money left and reads post-close continuation of winners", () => {
    const trades = [
      eff(50, "10", { postClose15m: 4, postClose30m: 6 }),
      eff(100, "20", { postClose15m: -2, postClose30m: -4 }),
      eff(0, "-10", { postClose15m: 9, postClose30m: 9 }), // loser: efficiency clamps to 0
      fxTrade({ netProfit: "5", mfePips: 0, postClose15m: 0, postClose30m: 1 }), // no MFE → not valid
    ];
    const m = computeExitAnalysis(fxSwift, trades);
    expect(m.validTrades).toHaveLength(3);
    expect(m.avgExitEfficiency).toBe(50);
    expect(m.totalMoneyLeftOnTable).toBe(10); // winners: 20 − 10, 20 − 20; loser excluded; MFE 0 excluded
    expect(m.winners).toHaveLength(3);
    expect(m.earlyExitPercent).toBeCloseTo(100 / 3, 12);
    expect(m.avgPostClose15m).toBeCloseTo(2 / 3, 12);
    expect(m.avgPostClose30m).toBe(1);
    expect(m.exitsEarly).toBe(true);
    expect(m.insightText).toMatch(/^Exiting early/);
  });

  it("insight bands < 50 / < 70 / < 85 / else", () => {
    expect(computeExitAnalysis(fxSwift, [eff(49)]).insightText).toMatch(/^Exiting way too early/);
    expect(computeExitAnalysis(fxSwift, [eff(70)]).insightText).toMatch(/^Solid exit timing/);
    expect(computeExitAnalysis(fxSwift, [eff(85)]).insightText).toMatch(/^Excellent exits/);
    expect(computeExitAnalysis(fxSwift, [eff(85)]).exitsEarly).toBe(false);
  });

  it("is all zeros for no trades", () => {
    const m = computeExitAnalysis(fxSwift, []);
    expect(m).toMatchObject({ avgExitEfficiency: 0, totalMoneyLeftOnTable: 0, earlyExitPercent: 0, avgPostClose15m: 0, avgPostClose30m: 0 });
    expect(m.distributionBuckets.map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it("PARITY D-03: swift counts edge values in two buckets, fixed uses half-open buckets", () => {
    const edges = [0, 20, 40, 60, 80, 100, 10].map((e) => eff(e));
    const swift = computeExitAnalysis(fxSwift, edges).distributionBuckets;
    expect(swift.map((b) => b.label)).toEqual(["0-20%", "20-40%", "40-60%", "60-80%", "80-100%"]);
    expect(swift.map((b) => b.count)).toEqual([3, 2, 2, 2, 2]); // 11 counts for 7 trades
    const fixed = computeExitAnalysis(fxFixed, edges).distributionBuckets;
    expect(fixed.map((b) => b.count)).toEqual([2, 1, 1, 1, 2]); // 7 counts, 100 in the last
  });

  it("unknown MFE (D-18) is not a valid trade in either mode", () => {
    const t = fxTrade({ netProfit: "5", mfePips: null });
    expect(computeExitAnalysis(fxSwift, [t]).validTrades).toEqual([]);
    expect(computeExitAnalysis(fxFixed, [t]).validTrades).toEqual([]);
  });
});

describe("ExitAnalysis ST", () => {
  const st = (e: number | null, p = "10") =>
    stTrade({ netProfit: p, mfePoints: 2, slDistPoints: e === null ? 0 : 1, rMultiple: e === null ? 0 : (e / 100) * 2 });

  it("early exit = winners with efficiency < 50 (nil counts as 100); no post-close fields", () => {
    const m = computeExitAnalysis(stSwift, [st(40), st(60), st(null), st(10, "-5")]);
    expect(m.earlyExitPercent).toBeCloseTo(100 / 3, 12);
    expect(m.avgPostClose15m).toBeNull();
    expect(m.avgPostClose30m).toBeNull();
    expect(m.validTrades).toHaveLength(3);
    expect(computeExitAnalysis(stSwift, []).earlyExitPercent).toBe(0);
  });

  it("is registered on the risk tab with the n ≥ 10 guard", () => {
    const reg = new AnalyticsRegistry().register(exitAnalysisComponent);
    expect(reg.run("ExitAnalysis", stSwift, Array.from({ length: 9 }, () => st(50)))).toBeNull();
    expect(reg.run("ExitAnalysis", stSwift, Array.from({ length: 10 }, () => st(50)))).toMatchObject({ avgExitEfficiency: 50 });
    expect(reg.list("dojix", "risk").map((c) => c.id)).toEqual(["ExitAnalysis"]);
  });
});

describe("ExitAnalysis parity encoding", () => {
  it("encodes trades as #ticket and buckets as {id, label, count}", () => {
    const trades = [eff(30)];
    const m = exitAnalysisParity.compute(fxSwift, trades, undefined);
    if (!m) throw new Error("no model");
    const get = (k: string) => exitAnalysisParity.members[k]?.(m, fxSwift);
    expect(get("validTrades")).toEqual(["#e30"]);
    expect(get("winners")).toEqual(["#e30"]);
    expect(get("distributionBuckets")).toEqual([
      { id: "0-20%", label: "0-20%", count: 0 },
      { id: "20-40%", label: "20-40%", count: 1 },
      { id: "40-60%", label: "40-60%", count: 0 },
      { id: "60-80%", label: "60-80%", count: 0 },
      { id: "80-100%", label: "80-100%", count: 0 },
    ]);
    expect(get("avgExitEfficiency")).toBeCloseTo(30, 12);
    expect(get("totalMoneyLeftOnTable")).toBeCloseTo(14, 12);
    expect(get("earlyExitPercent")).toBe(100);
    expect(get("avgPostClose15m")).toBe(5);
    expect(get("avgPostClose30m")).toBe(10);
    expect(get("exitsEarly")).toBe(true);
    expect(get("insightText")).toMatch(/^Exiting way too early/);
  });
});

describe("ExitAnalysis properties", () => {
  const num = fc.oneof(fc.double({ min: -1e9, max: 1e9, noNaN: true }), fc.constantFrom(0, 1, -1));
  it("no NaN for valid trades; buckets count every valid trade at least once", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: fc.integer({ min: -1e6, max: 1e6 }), r: num, mfe: fc.option(num, { nil: null }), sl: num, pc15: num, pc30: num }), { maxLength: 20 }),
        fc.constantFrom(fxSwift, fxFixed, stSwift),
        (rows, ctx) => {
          const trades = rows.map((r) =>
            ctx.brand === "dojix"
              ? fxTrade({ netProfit: String(r.p), rMultiple: r.r, mfePips: r.mfe, slDistPips: r.sl, postClose15m: r.pc15, postClose30m: r.pc30 })
              : stTrade({ netProfit: String(r.p), rMultiple: r.r, mfePoints: r.mfe, slDistPoints: r.sl }),
          );
          const m = computeExitAnalysis(ctx, trades);
          for (const v of [m.avgExitEfficiency, m.totalMoneyLeftOnTable, m.earlyExitPercent, m.avgPostClose15m ?? 0, m.avgPostClose30m ?? 0]) {
            expect(Number.isNaN(v)).toBe(false);
          }
          const counted = m.distributionBuckets.reduce((s, b) => s + b.count, 0);
          if (ctx.compat === "fixed") expect(counted).toBe(m.validTrades.length);
          else expect(counted).toBeGreaterThanOrEqual(m.validTrades.length);
        },
      ),
      { numRuns: 150 },
    );
  });
});
