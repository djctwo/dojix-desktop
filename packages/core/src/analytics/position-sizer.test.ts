import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computePositionSizer, parseSwiftDouble, positionSizerComponent, positionSizerParity } from "./position-sizer";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const st = createEngineContext({ brand: "greenwick", now: 0 });

describe("PositionSizer", () => {
  it("lots = risk / (avgSL × 10) (DojixTests/AnalyticsComponentTests.swift:303-335)", () => {
    // :303-318 — $10,000, 1%, 20 pips → $100 risk, 0.50 lots
    const a = computePositionSizer(fx, [fxTrade({ slDistPips: 20, lots: 0.5 })]);
    expect(a.riskPerTrade).toBeCloseTo(100, 2);
    if (a.brand !== "dojix") throw new Error("brand");
    expect(a.suggestedLots).toBe(0.5);
    expect(a.isSizingAligned).toBe(true);
    // :320-335 — $1,000, 2%, 30 pips → $20 risk, 0.067 → rounded to 0.07
    const b = computePositionSizer(fx, [fxTrade({ slDistPips: 30 })], { accountBalance: "1000", riskPercent: 2 });
    expect(b.riskPerTrade).toBeCloseTo(20, 2);
    expect(b.suggestedSize).toBe(0.07);
  });

  it("averages only positive stops, 20 when none; rounds half away from zero", () => {
    const m = computePositionSizer(fx, [fxTrade({ slDistPips: 0, lots: 1 }), fxTrade({ slDistPips: -5, lots: 3 })]);
    if (m.brand !== "dojix") throw new Error("brand");
    expect(m.avgSLPips).toBe(20);
    expect(m.currentAvgLots).toBe(2);
    expect(m.suggestedLots).toBe(0.5);
    expect(m.isSizingAligned).toBe(false); // 0.5 / 2 = 0.25
    // 125 / (40 × 10) = 0.3125 → ×100 = 31.25 → 31 → 0.31 ; 0.0625×… check a half: 50/(40×10)=0.125 → 12.5 → 13
    const half = computePositionSizer(fx, [fxTrade({ slDistPips: 40 })], { accountBalance: "5000" });
    expect(half.suggestedSize).toBe(0.13);
  });

  it("parses the balance like Swift Double(String), falling back to 10,000", () => {
    expect(parseSwiftDouble("25000")).toBe(25000);
    expect(parseSwiftDouble("+1.5e3")).toBe(1500);
    expect(parseSwiftDouble(".5")).toBe(0.5);
    expect(parseSwiftDouble("5.")).toBe(5);
    expect(parseSwiftDouble("-inf")).toBe(-Infinity);
    expect(parseSwiftDouble("Infinity")).toBe(Infinity);
    expect(parseSwiftDouble("nan")).toBeNaN();
    for (const bad of ["", " 100", "100 ", "1,000", "$100", "abc", "1e", "0x10"]) expect(parseSwiftDouble(bad)).toBeNull();
    expect(computePositionSizer(fx, [], { accountBalance: "1,000" }).balance).toBe(10_000);
  });

  it("aligned bounds: 0.5 and 2 inclusive; no trades counts as aligned", () => {
    const at = (lots: number) => computePositionSizer(fx, [fxTrade({ slDistPips: 20, lots })]).isSizingAligned;
    expect(at(1)).toBe(true); // 0.5 / 1
    expect(at(0.25)).toBe(true); // 2
    expect(at(1.01)).toBe(false);
    expect(at(0.24)).toBe(false);
    expect(computePositionSizer(fx, []).isSizingAligned).toBe(true);
    expect(computePositionSizer(fx, []).currentAvgSize).toBe(0);
  });

  it("Greenwick: shares = risk / avg stop points, rounded to 0.01", () => {
    const m = computePositionSizer(st, [stTrade({ slDistPoints: 3, shares: 30 }), stTrade({ slDistPoints: 0, shares: 40 })]);
    if (m.brand !== "greenwick") throw new Error("brand");
    expect(m.avgSLPoints).toBe(3);
    expect(m.suggestedShares).toBe(33.33);
    expect(m.currentAvgShares).toBe(35);
    expect(m.isSizingAligned).toBe(true);
    const none = computePositionSizer(st, []);
    expect(none.avgSL).toBe(20);
    expect(none.suggestedSize).toBe(5); // 100 / 20
  });

  it("falls back when the average stop is not positive (NaN stop)", () => {
    // Only reachable with a NaN/∞ stop: ∞ is positive, so its average is ∞ → size 0.
    expect(computePositionSizer(fx, [fxTrade({ slDistPips: Infinity })]).suggestedSize).toBe(0);
    expect(computePositionSizer(fx, [], { accountBalance: "nan" }).suggestedSize).toBeNaN();
  });

  it("registers (always shown) and resolves the default and balance25k_risk2 instances", () => {
    const reg = new AnalyticsRegistry().register(positionSizerComponent);
    expect(reg.run("PositionSizer", fx, [])).toMatchObject({ balance: 10_000, riskPerTrade: 100 });
    const trades = [fxTrade({ slDistPips: 25, lots: 1 })];
    const inst = positionSizerParity.compute(fx, trades, "balance25k_risk2");
    if (!inst) throw new Error("instance");
    expect(positionSizerParity.members.balance?.(inst, fx)).toBe(25_000);
    expect(positionSizerParity.members.riskPerTrade?.(inst, fx)).toBe(500);
    expect(positionSizerParity.members.suggestedLots?.(inst, fx)).toBe(2);
    expect(positionSizerParity.members.avgSLPips?.(inst, fx)).toBe(25);
    expect(positionSizerParity.members.currentAvgLots?.(inst, fx)).toBe(1);
    expect(positionSizerParity.members.isSizingAligned?.(inst, fx)).toBe(true);
    expect(positionSizerParity.members.suggestedShares?.(inst, fx)).toBeUndefined();
    expect(positionSizerParity.compute(fx, trades, "other")).toBeUndefined();
    const g = positionSizerParity.compute(st, [stTrade({ slDistPoints: 2, shares: 50 })], undefined);
    if (!g) throw new Error("gw");
    expect(positionSizerParity.members.suggestedShares?.(g, st)).toBe(50);
    expect(positionSizerParity.members.avgSLPoints?.(g, st)).toBe(2);
    expect(positionSizerParity.members.currentAvgShares?.(g, st)).toBe(50);
    expect(positionSizerParity.members.suggestedLots?.(g, st)).toBeUndefined();
    expect(positionSizerParity.members.avgSLPips?.(g, st)).toBeUndefined();
    expect(positionSizerParity.members.currentAvgLots?.(g, st)).toBeUndefined();
  });

  it("never throws or yields NaN for valid input (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ sl: fc.double({ min: -1e6, max: 1e6, noNaN: true }), lots: fc.double({ min: 0, max: 1e4, noNaN: true }) }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 1e9 }),
        (rows, r, bal) => {
          const m = computePositionSizer(fx, rows.map((x) => fxTrade({ slDistPips: x.sl, lots: x.lots })), { accountBalance: String(bal), riskPercent: r * 0.25 });
          for (const v of [m.balance, m.riskPerTrade, m.avgSL, m.suggestedSize, m.currentAvgSize]) expect(Number.isNaN(v)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
