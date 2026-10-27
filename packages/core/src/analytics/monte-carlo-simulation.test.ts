import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxSeries, stTrade } from "../test-support/trades";
import {
  computeMonteCarloSimulation,
  monteCarloShuffleInvariantViolations,
  monteCarloSimulationComponent,
  monteCarloSimulationParity,
  type MonteCarloResult,
} from "./monte-carlo-simulation";

const swift = (seed = 7) => createEngineContext({ brand: "dojix", now: 0, compat: "swift", seed });
const fixed = (seed = 7) => createEngineContext({ brand: "dojix", now: 0, compat: "fixed", seed });

/** 15 alternating trades: +100, −90, … (total 170). */
const alternating = fxSeries(Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? "100" : "-90"))).reverse();

function result(m: { result: MonteCarloResult | null }): MonteCarloResult {
  if (!m.result) throw new Error("expected a result");
  return m.result;
}

describe("MonteCarloSimulation", () => {
  it("needs 15 trades (MonteCarloSimulation.swift:34)", () => {
    const m = computeMonteCarloSimulation(swift(), alternating.slice(0, 14));
    expect(m.result).toBeNull();
    expect(m.tradeCount).toBe(14);
    expect(computeMonteCarloSimulation(swift(), []).target).toBe(500);
  });

  it("swift compat: every shuffled path ends at the total (D-05 on the Mac)", () => {
    const m = computeMonteCarloSimulation(swift(), alternating);
    const r = result(m);
    expect(m.method).toBe("shuffle");
    expect(m.totalPnL).toBe(170);
    expect(m.target).toBe(500); // max(2 × 170, 500)
    expect(monteCarloShuffleInvariantViolations(r, m.totalPnL)).toEqual([]);
    expect(r.probTarget).toBe(0); // "Hit Target" is always 0 on the Mac
    expect(r.probProfit).toBe(1);
    expect(r.medianFinalPnL).toBeCloseTo(170, 9);
    expect(r.bands.map((b) => b.label)).toEqual(["5th", "25th", "Median", "75th", "95th"]);
    expect(r.bands.map((b) => b.opacity)).toEqual([0.15, 0.2, 0.8, 0.2, 0.15]);
  });

  it("fixed (D-05): a seeded bootstrap whose finals spread around the total", () => {
    const m = computeMonteCarloSimulation(fixed(), alternating);
    const r = result(m);
    expect(m.method).toBe("bootstrap");
    expect(r.bestCase).toBeGreaterThan(r.worstCase);
    expect(monteCarloShuffleInvariantViolations(r, m.totalPnL)).not.toEqual([]);
    expect(r.probTarget).toBeGreaterThan(0); // the target is reachable when resampling
    expect(r.probProfit).toBeGreaterThan(0);
    expect(r.probProfit).toBeLessThan(1);
  });

  it("is deterministic per seed and changes with the seed", () => {
    for (const ctx of [swift, fixed]) {
      const varied = fxSeries(["13", "-7", "29", "-41", "3", "17", "-23", "31", "-2", "11", "-19", "37", "5", "-43", "47"]);
      const a = computeMonteCarloSimulation(ctx(11), varied, { simulationCount: 50 });
      const b = computeMonteCarloSimulation(ctx(11), varied, { simulationCount: 50 });
      expect(a).toEqual(b);
      const c = computeMonteCarloSimulation(ctx(12), varied, { simulationCount: 50 });
      expect(result(c).bands).not.toEqual(result(a).bands);
      expect(a.seed).toBe(11);
    }
    // an explicit seed overrides the context's
    expect(computeMonteCarloSimulation(swift(1), alternating, { seed: 11 })).toEqual(computeMonteCarloSimulation(swift(11), alternating));
  });

  it("keeps the bands ordered, starting at 0 with n + 1 points", () => {
    for (const ctx of [swift(), fixed()]) {
      const r = result(computeMonteCarloSimulation(ctx, alternating));
      for (const b of r.bands) {
        expect(b.points).toHaveLength(16);
        expect(b.points[0]).toBe(0);
      }
      for (let i = 0; i <= 15; i++) {
        const col = r.bands.map((b) => b.points[i] as number);
        for (let k = 1; k < col.length; k++) expect(col[k]).toBeGreaterThanOrEqual(col[k - 1] as number);
      }
      expect(r.worstCase).toBeLessThanOrEqual(r.medianFinalPnL);
      expect(r.medianFinalPnL).toBeLessThanOrEqual(r.bestCase);
    }
  });

  it("counts a path once it falls .2 × max(total, 1000) below its peak", () => {
    // One −300 trade among 14 small wins: every path drops ≥ 200 at that trade.
    const trades = fxSeries([...Array.from({ length: 14 }, () => "10"), "-300"]);
    const r = result(computeMonteCarloSimulation(swift(), trades));
    expect(r.probDrawdown20).toBe(1);
    // All wins: never in drawdown, always profitable.
    const ups = result(computeMonteCarloSimulation(swift(), fxSeries(Array.from({ length: 15 }, () => "10"))));
    expect(ups.probDrawdown20).toBe(0);
    expect(ups.probProfit).toBe(1);
    // A drawdown of exactly the threshold counts (≥).
    const edge = fxSeries([...Array.from({ length: 14 }, () => "0"), "-200"]);
    expect(result(computeMonteCarloSimulation(swift(), edge)).probDrawdown20).toBe(1);
  });

  it("reads the band positions Int((sims − 1) × p) and the median at sims / 2", () => {
    const m = computeMonteCarloSimulation(fixed(3), alternating, { simulationCount: 10 });
    const r = result(m);
    // positions 0, 2, 4, 6, 8 for 10 sims; finals[5] is the median
    expect(r.bands[2]?.points).toHaveLength(16);
    expect(r.worstCase).toBe(r.bands[0]?.points[15]);
    expect(r.bestCase).toBe(r.bands[4]?.points[15]);
    expect(r.medianFinalPnL).toBeGreaterThanOrEqual(r.bands[2]?.points[15] as number);
    expect(() => computeMonteCarloSimulation(fixed(), alternating, { simulationCount: 0 })).toThrow(RangeError);
    expect(() => computeMonteCarloSimulation(fixed(), alternating, { simulationCount: 1.5 })).toThrow(RangeError);
  });

  it("flags every broken invariant", () => {
    const bad: MonteCarloResult = {
      bands: [{ label: "5th", points: [1, 2], opacity: 0.15 }],
      probProfit: 0.5,
      probTarget: 0.1,
      probDrawdown20: 0,
      medianFinalPnL: 1,
      worstCase: 1,
      bestCase: 1,
    };
    expect(monteCarloShuffleInvariantViolations(bad, 100)).toEqual([
      "medianFinalPnL",
      "worstCase",
      "bestCase",
      "probTarget",
      "probProfit",
      "bands",
      "5th.start",
      "5th.end",
    ]);
    expect(monteCarloShuffleInvariantViolations({ ...bad, probProfit: 1 }, -100)).toContain("probProfit");
    expect(monteCarloShuffleInvariantViolations({ ...bad, bands: [{ label: "x", points: [], opacity: 0 }] }, 1)).toContain("x.end");
  });

  it("serves Greenwick and registers with the 15-trade guard; parity reads `result`", () => {
    const st = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });
    const trades = Array.from({ length: 15 }, (_, i) => stTrade({ netProfit: i % 3 === 0 ? "-40" : "25", closeTime: Date.UTC(2026, 9, 1 + i, 18) }));
    const m = computeMonteCarloSimulation(st, trades);
    expect(monteCarloShuffleInvariantViolations(result(m), m.totalPnL)).toEqual([]);
    const reg = new AnalyticsRegistry().register(monteCarloSimulationComponent);
    expect(reg.run("MonteCarloSimulation", st, trades.slice(1))).toBeNull();
    expect(reg.run("MonteCarloSimulation", st, trades)).not.toBeNull();
    expect(Object.keys(monteCarloSimulationParity.members)).toEqual(["result"]);
    const enc = monteCarloSimulationParity.members.result?.(m, st) as Record<string, unknown>;
    expect(Object.keys(enc).sort()).toEqual(["bands", "bestCase", "medianFinalPnL", "probDrawdown20", "probProfit", "probTarget", "worstCase"]);
    expect(enc.probTarget).toBe(0); // every shuffled path ends at the total (D-05 on the Mac)
    expect(monteCarloSimulationParity.members.result?.({ ...m, result: null }, st)).toBeNull();
    expect(monteCarloSimulationParity.compute(st, trades, undefined)?.tradeCount).toBe(15);
  });

  it("never throws or yields NaN for storage-valid input (property)", () => {
    const money = fc.integer({ min: -100_000_000, max: 100_000_000 }).map((c) => String(c / 100));
    fc.assert(
      fc.property(fc.array(money, { minLength: 15, maxLength: 25 }), fc.boolean(), fc.nat(), (ps, isFixed, seed) => {
        const ctx = isFixed ? fixed(seed) : swift(seed);
        const m = computeMonteCarloSimulation(ctx, fxSeries(ps), { simulationCount: 20 });
        const r = result(m);
        for (const v of [r.probProfit, r.probTarget, r.probDrawdown20, r.medianFinalPnL, r.worstCase, r.bestCase]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        for (const b of r.bands) expect(b.points.every(Number.isFinite)).toBe(true);
        if (!isFixed) expect(r.probTarget).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
