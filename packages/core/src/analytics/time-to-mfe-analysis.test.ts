import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { INT_MAX } from "../swiftcompat/int";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeTimeToMFEAnalysis, timeToMFEAnalysisComponent, timeToMFEAnalysisParity } from "./time-to-mfe-analysis";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const fxFixed = createEngineContext({ brand: "dojix", now: 0, compat: "fixed" });
const st = createEngineContext({ brand: "greenwick", now: 0 });

const ttm = (values: readonly number[], durationMin = 60) =>
  values.map((v, i) => fxTrade({ timeToMFEMin: v, durationMin, closeTime: Date.UTC(2026, 0, 5, 10, i) }));

describe("TimeToMFEAnalysis", () => {
  it("keeps trades with ttMFE > 0 and buckets closed ranges", () => {
    const m = computeTimeToMFEAnalysis(fx, ttm([0, -3, 1, 5, 6, 15, 16, 30, 31, 60, 61, 999_999, 1_000_000]));
    expect(m.validTrades).toHaveLength(11);
    expect(m.buckets).toEqual([
      { id: "0-5m", label: "0-5m", count: 2 },
      { id: "5-15m", label: "5-15m", count: 2 },
      { id: "15-30m", label: "15-30m", count: 2 },
      { id: "30-60m", label: "30-60m", count: 2 },
      { id: "1h+", label: "1h+", count: 2 }, // 1,000,000 falls in no bucket
    ]);
  });

  it("drops empty buckets", () => {
    expect(computeTimeToMFEAnalysis(fx, ttm([20, 25])).buckets).toEqual([{ id: "15-30m", label: "15-30m", count: 2 }]);
  });

  it("medians: middle value, or the truncated mean of the two middle values", () => {
    expect(computeTimeToMFEAnalysis(fx, ttm([9, 1, 5])).medianTimeToMFE).toBe(5);
    expect(computeTimeToMFEAnalysis(fx, ttm([1, 4, 9, 2])).medianTimeToMFE).toBe(3); // (2 + 4) / 2
    expect(computeTimeToMFEAnalysis(fx, ttm([1, 2, 5, 10])).medianTimeToMFE).toBe(3); // 3.5 → 3
    expect(computeTimeToMFEAnalysis(fx, ttm([])).medianTimeToMFE).toBe(0);
  });

  it("average hold and overholding (> 2× median, median > 0)", () => {
    const m = computeTimeToMFEAnalysis(fx, ttm([10, 10, 10], 21));
    expect(m.avgHoldTime).toBe(21);
    expect(m.isOverholding).toBe(true);
    expect(computeTimeToMFEAnalysis(fx, ttm([10, 10], 20)).isOverholding).toBe(false);
    expect(computeTimeToMFEAnalysis(fx, ttm([])).isOverholding).toBe(false);
    const mixed = [fxTrade({ timeToMFEMin: 5, durationMin: 10, closeTime: 1 }), fxTrade({ timeToMFEMin: 5, durationMin: 15, closeTime: 2 })];
    expect(computeTimeToMFEAnalysis(fx, mixed).avgHoldTime).toBe(12); // 12.5 truncated
  });

  it("saturates huge durations per brand flavour", () => {
    const big = [fxTrade({ timeToMFEMin: 1, durationMin: 2 ** 63 - 512, closeTime: 1 })];
    expect(computeTimeToMFEAnalysis(fx, big).avgHoldTime).toBe(INT_MAX); // Dojix saturates from 2^63 − 1024
    const bigSt = [stTrade({ timeToMFEMin: 1, durationMin: 2 ** 62, closeTime: 1 })];
    expect(computeTimeToMFEAnalysis(st, bigSt).avgHoldTime).toBe(2 ** 62);
  });

  it("averages exit efficiency over trades that have one", () => {
    const a = fxTrade({ timeToMFEMin: 5, rMultiple: 1, slDistPips: 20, mfePips: 40, closeTime: 1 }); // 50
    const b = fxTrade({ timeToMFEMin: 5, rMultiple: 2, slDistPips: 20, mfePips: 40, closeTime: 2 }); // 100
    const c = fxTrade({ timeToMFEMin: 5, mfePips: 0, closeTime: 3 }); // none
    const d = fxTrade({ timeToMFEMin: 0, rMultiple: 0, mfePips: 40, closeTime: 4 }); // not valid
    expect(computeTimeToMFEAnalysis(fx, [a, b, c, d]).avgExitEfficiency).toBe(75);
    expect(computeTimeToMFEAnalysis(fx, [c]).avgExitEfficiency).toBeNull();
    // D-18: unknown MFE has no efficiency in either mode.
    const u = fxTrade({ timeToMFEMin: 5, mfePips: null, closeTime: 5 });
    expect(computeTimeToMFEAnalysis(fxFixed, [u]).avgExitEfficiency).toBeNull();
    expect(computeTimeToMFEAnalysis(fx, [u]).avgExitEfficiency).toBeNull();
  });

  it("registry: empty state below 10 valid trades", () => {
    const reg = new AnalyticsRegistry().register(timeToMFEAnalysisComponent);
    const nine = [...ttm(Array(9).fill(5)), ...ttm([0, 0, 0])];
    expect(reg.run("TimeToMFEAnalysis", fx, nine)).toBeNull();
    expect(reg.run("TimeToMFEAnalysis", fx, ttm(Array(10).fill(5)))).toMatchObject({ medianTimeToMFE: 5 });
    expect(reg.list("greenwick", "advanced").map((c) => c.id)).toEqual(["TimeToMFEAnalysis"]);
  });

  it("encodes members like the harness", () => {
    const trades = [fxTrade({ ticket: "11", timeToMFEMin: 7, closeTime: 1 })];
    const m = timeToMFEAnalysisParity.compute(fx, trades, undefined);
    if (!m) throw new Error("no model");
    const enc = (k: string) => timeToMFEAnalysisParity.members[k]?.(m, fx);
    expect(enc("validTrades")).toEqual(["#11"]);
    expect(enc("buckets")).toEqual([{ id: "5-15m", label: "5-15m", count: 1 }]);
    expect([enc("medianTimeToMFE"), enc("avgHoldTime"), enc("isOverholding")]).toEqual([7, 60, true]);
    expect(enc("avgExitEfficiency")).toBe(100); // R 1 × 20 pips over a 10-pip MFE, clamped
  });

  it("never throws; Ints stay integers", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ timeToMFEMin: fc.integer({ min: -10, max: 2_000_000 }), durationMin: fc.integer({ min: 0, max: 5_270_400 }) }), { maxLength: 30 }), (rows) => {
        for (const ctx of [fx, fxFixed, st]) {
          const trades = rows.map((r, i) => (ctx.brand === "dojix" ? fxTrade({ ...r, closeTime: i }) : stTrade({ ...r, closeTime: i })));
          const m = computeTimeToMFEAnalysis(ctx, trades);
          expect(Number.isInteger(m.medianTimeToMFE) && Number.isInteger(m.avgHoldTime)).toBe(true);
          if (m.avgExitEfficiency !== null) expect(Number.isNaN(m.avgExitEfficiency)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
