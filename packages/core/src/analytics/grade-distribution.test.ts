import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computeGradeDistribution, gradeDistributionComponent, gradeDistributionParity } from "./grade-distribution";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });

// fxTrade defaults (R 1, MAE 5 / MFE 10, London 10:00 WITH, slip 0.5, pc30 10, 60 min):
// R 17, execution 7 + 5 = 12, timing 10 + 7 + 5 = 22.
const aTrade = () =>
  fxTrade({ netProfit: "50", rMultiple: 3, maePips: 1, mfePips: 10, usedFVG: true, hour: 8, slippagePips: 0.1, postClose30m: 1, hitBreakeven: true }); // 25+25+25+25
const cTrade = () => fxTrade({ netProfit: "-5", rMultiple: -0.2, maePips: 10, mfePips: 10, slippagePips: 3 }); // 5 + 7 + 22 + (10 + 4) = 48 → D

describe("GradeDistribution", () => {
  it("counts letters in A…F order, omits empty ones, and averages the Int totals", () => {
    const trades = [aTrade(), cTrade(), aTrade(), cTrade(), cTrade()];
    const m = computeGradeDistribution(fx, trades);
    expect(m.gradeData).toEqual([
      { id: "A", grade: "A", count: 2, percent: 40 },
      { id: "D", grade: "D", count: 3, percent: 60 },
    ]);
    expect(m.averageScore).toBe((100 * 2 + 48 * 3) / 5);
    expect(m.abPercent).toBe(40);
    expect(m.dfPercent).toBe(60);
  });

  it("is empty for no trades and guarded at 5 trades in the registry", () => {
    expect(computeGradeDistribution(fx, [])).toEqual({ gradeData: [], averageScore: 0, abPercent: 0, dfPercent: 0 });
    const reg = new AnalyticsRegistry().register(gradeDistributionComponent);
    expect(reg.run("GradeDistribution", fx, [aTrade(), aTrade(), aTrade(), aTrade()])).toBeNull();
    expect(reg.list("greenwick", "behavioral").map((c) => c.id)).toEqual(["GradeDistribution"]);
    const five = reg.run("GradeDistribution", st, [1, 2, 3, 4, 5].map(() => stTrade({ netProfit: "1" })));
    // stTrade defaults: R 0 → 8, execution 3 + 5, timing Regular 10 + hour 10 (in 9…10) → 10, management 10 + 2 (no SL → no efficiency) = 48 → D
    expect(five).toMatchObject({ gradeData: [{ grade: "D", count: 5, percent: 100 }], averageScore: 48 });
  });

  it("encodes gradeData without the colour and averageScore as a Double", () => {
    const m = gradeDistributionParity.compute(fx, [aTrade()], undefined);
    expect(m && gradeDistributionParity.members.gradeData?.(m, fx)).toEqual([{ id: "A", grade: "A", count: 1, percent: 100 }]);
    expect(m && gradeDistributionParity.members.averageScore?.(m, fx)).toBe(100);
  });

  it("never produces NaN for valid trades", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ p: fc.integer({ min: -1000, max: 1000 }), r: fc.double({ min: -10, max: 10, noNaN: true }) }), { maxLength: 20 }), (rows) => {
        const m = computeGradeDistribution(fx, rows.map((r) => fxTrade({ netProfit: String(r.p), rMultiple: r.r })));
        expect(Number.isNaN(m.averageScore)).toBe(false);
        let sum = 0;
        for (const b of m.gradeData) sum += b.count;
        expect(sum).toBe(rows.length);
      }),
      { numRuns: 100 },
    );
  });
});
