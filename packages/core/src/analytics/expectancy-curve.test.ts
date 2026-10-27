import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxSeries, stTrade } from "../test-support/trades";
import { computeExpectancyCurve, expectancyCurveComponent, expectancyCurveParity } from "./expectancy-curve";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const F1 = ["100", "50", "-30", "-20", "80"];

describe("ExpectancyCurve", () => {
  it("actual = running total ASC, projected = E × (i + 1)", () => {
    const trades = fxSeries([...F1, ...F1]).reverse(); // repository order
    const m = computeExpectancyCurve(fx, trades);
    expect(m.expectancy).toBeCloseTo(36, 12); // F1 expectancy
    expect(m.projectionPoints.map((p) => p.actual)).toEqual([100, 150, 120, 100, 180, 280, 330, 300, 280, 360]);
    expect(m.projectionPoints[0]).toEqual({ trade: 1, actual: 100, projected: m.expectancy });
    expect(m.projectionPoints[9]?.projected).toBeCloseTo(360, 9);
    // E × n equals the total (breakevens included), so the deviation is ±0%.
    expect(m.deviation).toMatch(/^[+-]?0% vs expected$/);
  });

  it("projects E × 50 = 750 (DojixTests/AnalyticsComponentTests.swift:337-343)", () => {
    const trades = fxSeries(Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? "45" : "-15")));
    const m = computeExpectancyCurve(fx, trades);
    expect(m.expectancy).toBe(15);
    expect(m.projectionPoints[49]?.projected).toBe(750);
  });

  it("formats the deviation with a + for ≥ 0 and %.0f%%", () => {
    // Fake an off-curve model through a tiny fp difference: 0.1 + 0.2 … vs E × n.
    const trades = fxSeries(Array.from({ length: 10 }, (_, i) => (i < 9 ? "0.1" : "0.2")));
    const m = computeExpectancyCurve(fx, trades);
    const last = m.projectionPoints[9];
    if (!last) throw new Error("points");
    const diff = last.actual - last.projected;
    expect(m.deviation.startsWith(diff >= 0 ? "+" : "-")).toBe(true);
  });

  it("is empty below 10 trades or when E == 0", () => {
    expect(computeExpectancyCurve(fx, fxSeries(F1))).toMatchObject({ projectionPoints: [], deviation: "—" });
    const flat = fxSeries(Array.from({ length: 12 }, () => "0"));
    expect(computeExpectancyCurve(fx, flat).projectionPoints).toEqual([]);
    const reg = new AnalyticsRegistry().register(expectancyCurveComponent);
    expect(reg.run("ExpectancyCurve", fx, flat)).toBeNull();
    expect(reg.run("ExpectancyCurve", fx, fxSeries([...F1, ...F1]))).not.toBeNull();
  });

  it("serves Greenwick and encodes the tuples as objects", () => {
    const st = createEngineContext({ brand: "greenwick", now: 0 });
    const trades = Array.from({ length: 10 }, (_, i) => stTrade({ netProfit: i % 2 ? "-10" : "30", closeTime: Date.UTC(2026, 8, 1 + i, 18) }));
    const m = expectancyCurveParity.compute(st, trades, undefined);
    if (!m) throw new Error("model");
    expect(m.expectancy).toBe(10);
    expect((expectancyCurveParity.members.projectionPoints?.(m, st) as unknown[])[0]).toEqual({ trade: 1, actual: 30, projected: 10 });
    expect(expectancyCurveParity.members.deviation?.(m, st)).toBe("+0% vs expected");
  });

  it("never throws or yields NaN for valid input (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e10, max: 1e10 }), { maxLength: 30 }), (cents) => {
        const m = computeExpectancyCurve(fx, fxSeries(cents.map((c) => String(c / 100))));
        for (const p of m.projectionPoints) expect(Number.isNaN(p.actual) || Number.isNaN(p.projected)).toBe(false);
        expect(m.deviation).not.toMatch(/nan/);
      }),
      { numRuns: 150 },
    );
  });
});
