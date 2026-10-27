// TradeGrader: every assertion of Dojix `DojixTests/TradeGraderTests.swift`, ported test for
// test (cited by line), plus exact derived values, the Greenwick variant, D-18 and properties.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { EMPTY_METRICS } from "../metrics/metrics-calculator";
import type { DojixTrade, GreenwickTrade } from "../model/trade";
import { fxTrade, stTrade } from "../test-support/trades";
import { gradeLetter, gradeRMultiple, gradeTrade, gradeTrades, tradeGraderParity, TRADE_GRADE_LETTERS } from "./trade-grader";

const swift = { compat: "swift" } as const;
const fixed = { compat: "fixed" } as const;

/** TradeGraderTests.swift:8-41 `makeTrade` defaults. */
function makeTrade(o: Partial<DojixTrade> = {}): DojixTrade {
  return fxTrade({
    ticket: "1",
    netProfit: "50",
    lots: 0.1,
    rMultiple: 1.0,
    maePips: 5,
    mfePips: 15,
    session: "LONDON",
    hour: 10,
    durationMin: 60,
    usedFVG: false,
    hitBreakeven: false,
    slippagePips: 0.5,
    postClose15m: 5,
    postClose30m: 8,
    biasAtEntry: "WITH",
    slDistPips: 20,
    ...o,
  });
}

/** TradeGraderTests.swift:43-55: only averageDuration (45) is read. */
const defaultMetrics = { ...EMPTY_METRICS, averageDuration: 45 };
const grade = (o: Partial<DojixTrade> = {}, metrics = defaultMetrics) => gradeTrade(makeTrade(o), metrics, swift);

describe("TradeGrader FX: R-multiple (TradeGraderTests.swift:59-129)", () => {
  it.each([
    [3.5, 25, 59],
    [3.0, 25, 65],
    [2.0, 22, 71],
    [1.5, 20, 77],
    [1.2, 17, 83],
    [0.5, 13, 89],
    [0.0, 8, 95],
    [-0.3, 5, 101],
    [-0.8, 3, 107],
    [-1.5, 0, 113],
    [10.0, 25, 119],
    [-5.0, 0, 125],
  ])("R %d → %d (line %d)", (r, expected) => {
    expect(grade({ rMultiple: r }).rScore).toBe(expected);
  });

  it("falls through every threshold for NaN, and -1 exactly is 3", () => {
    expect(gradeRMultiple(NaN)).toBe(0);
    expect(gradeRMultiple(-1)).toBe(3);
    expect(gradeRMultiple(Infinity)).toBe(25);
  });
});

describe("TradeGrader FX: execution (TradeGraderTests.swift:133-178)", () => {
  it("good MFE/MAE + low slippage + FVG = 25 (line 133)", () => {
    expect(grade({ maePips: 5, mfePips: 30, usedFVG: true, slippagePips: 0.3 }).executionScore).toBe(25);
  });
  it("poor ratio and high slippage ≤ 5 (line 140); exactly 3", () => {
    const s = grade({ maePips: 20, mfePips: 5, usedFVG: false, slippagePips: 3.0 }).executionScore;
    expect(s).toBeLessThanOrEqual(5);
    expect(s).toBe(3);
  });
  it("zero MAE with positive MFE → ratio 10 (line 147); exactly 20", () => {
    const s = grade({ maePips: 0, mfePips: 20, slippagePips: 0.3 }).executionScore;
    expect(s).toBeGreaterThanOrEqual(15);
    expect(s).toBe(20);
  });
  it("zero MAE and MFE → 3 + 5 = 8 (line 155)", () => {
    expect(grade({ maePips: 0, mfePips: 0, slippagePips: 0.3 }).executionScore).toBe(8);
  });
  it("FVG adds exactly 5 (line 163)", () => {
    const w = grade({ maePips: 10, mfePips: 10, usedFVG: true, slippagePips: 1.5 }).executionScore;
    const wo = grade({ maePips: 10, mfePips: 10, usedFVG: false, slippagePips: 1.5 }).executionScore;
    expect(w - wo).toBe(5);
    expect(wo).toBe(8); // ratio 1 → 7, slippage ≤ 2 → 1
  });
  it("is capped at 25 (line 173)", () => {
    expect(grade({ maePips: 1, mfePips: 100, usedFVG: true, slippagePips: 0.1 }).executionScore).toBe(25);
  });
  it("covers the 2 / 1.5 ratio bands and the slippage bands", () => {
    expect(grade({ maePips: 10, mfePips: 20, slippagePips: 1.0 }).executionScore).toBe(15); // 12 + 3
    expect(grade({ maePips: 10, mfePips: 15, slippagePips: 2.5 }).executionScore).toBe(10); // 10 + 0
  });
});

describe("TradeGrader FX: timing (TradeGraderTests.swift:182-240)", () => {
  it("London + hour 9 + WITH = 25 (line 182)", () => {
    expect(grade({ session: "LONDON", hour: 9, biasAtEntry: "WITH" }).timingScore).toBe(25);
  });
  it("NY Overlap + hour 13 + WITH = 25 (line 189)", () => {
    expect(grade({ session: "NY_OVERLAP", hour: 13, biasAtEntry: "WITH" }).timingScore).toBe(25);
  });
  it("NY + 13 + WITH = 22 (line 196)", () => {
    expect(grade({ session: "NY", hour: 13, biasAtEntry: "WITH" }).timingScore).toBe(22);
  });
  it("Asian + 3 + NEUTRAL = 8 (line 203)", () => {
    expect(grade({ session: "ASIAN", hour: 3, biasAtEntry: "NEUTRAL" }).timingScore).toBe(8);
  });
  it("Late + 3 + AGAINST ≤ 5 (line 210); exactly 3", () => {
    const s = grade({ session: "LATE", hour: 3, biasAtEntry: "AGAINST" }).timingScore;
    expect(s).toBeLessThanOrEqual(5);
    expect(s).toBe(3);
  });
  it("WITH − NEUTRAL = 3 (line 217); WITH − AGAINST = 5 (line 226)", () => {
    const w = grade({ session: "LONDON", hour: 8, biasAtEntry: "WITH" }).timingScore;
    expect(w - grade({ session: "LONDON", hour: 8, biasAtEntry: "NEUTRAL" }).timingScore).toBe(3);
    expect(w - grade({ session: "LONDON", hour: 8, biasAtEntry: "AGAINST" }).timingScore).toBe(5);
  });
  it("never exceeds 25 (line 235)", () => {
    expect(grade({ session: "LONDON", hour: 7, biasAtEntry: "WITH" }).timingScore).toBeLessThanOrEqual(25);
  });
  it("hour bands: the first matching closed range wins", () => {
    const t = (hour: number) => grade({ session: "ASIAN", hour, biasAtEntry: "AGAINST" }).timingScore - 5;
    expect([7, 9, 12, 14].map(t)).toEqual([10, 10, 10, 10]);
    expect([10, 11, 15, 16].map(t)).toEqual([7, 7, 7, 7]);
    expect([17, 21].map(t)).toEqual([4, 4]);
    expect([0, 6, 22, 23].map(t)).toEqual([1, 1, 1, 1]);
  });
});

describe("TradeGrader FX: management (TradeGraderTests.swift:244-274)", () => {
  it("winner, breakeven hit, normal duration, small continuation = 25 (line 244)", () => {
    expect(grade({ netProfit: "100", durationMin: 45, hitBreakeven: true, postClose30m: 2 }).managementScore).toBe(25);
  });
  it("loser cut quickly ≥ 10 (line 252); exactly 6 + 8 = 14", () => {
    const s = grade({ netProfit: "-30", durationMin: 15, postClose30m: 0 }).managementScore;
    expect(s).toBeGreaterThanOrEqual(10);
    expect(s).toBe(14);
  });
  it("extreme duration < 20 (line 260); exactly 2 + 10 = 12", () => {
    const s = grade({ netProfit: "20", durationMin: 225, postClose30m: 3 }).managementScore;
    expect(s).toBeLessThan(20);
    expect(s).toBe(12);
  });
  it("large post-close continuation < 20 (line 268); exactly 10 + 2 = 12", () => {
    const s = grade({ netProfit: "50", durationMin: 45, postClose30m: 30 }).managementScore;
    expect(s).toBeLessThan(20);
    expect(s).toBe(12);
  });
  it("breakeven counts as a non-win: no BE bonus, quick-cut rule; avgDur/2 truncates", () => {
    // avgDur 45 → threshold max(45 / 2, 5) = 22 (Int division), not 22.5.
    expect(grade({ netProfit: "0", hitBreakeven: true, durationMin: 22 }).managementScore).toBe(6 + 8);
    expect(grade({ netProfit: "0", hitBreakeven: true, durationMin: 23 }).managementScore).toBe(10 + 4);
    expect(grade({ netProfit: "50", postClose30m: 14.9 }).managementScore).toBe(10 + 6);
  });
});

describe("TradeGrader FX: overall (TradeGraderTests.swift:278-444)", () => {
  it("excellent trade → A (line 278); exactly 100", () => {
    const g = grade({
      rMultiple: 3,
      maePips: 3,
      mfePips: 25,
      session: "LONDON",
      hour: 8,
      usedFVG: true,
      hitBreakeven: true,
      slippagePips: 0.2,
      postClose30m: 2,
      biasAtEntry: "WITH",
    });
    expect(g.overall).toBe("A");
    expect(g.total).toBe(100);
  });
  it("terrible trade → D or F (line 292); exactly 20 → F", () => {
    const g = grade({
      netProfit: "-100",
      rMultiple: -2,
      maePips: 30,
      mfePips: 3,
      session: "LATE",
      hour: 2,
      slippagePips: 3,
      postClose30m: 25,
      biasAtEntry: "AGAINST",
    });
    expect(["D", "F"]).toContain(g.overall);
    expect(g).toEqual({ overall: "F", rScore: 0, executionScore: 3, timingScore: 3, managementScore: 14, total: 20 });
  });
  it("total = sum of the dimensions (line 307); the default trade is 75 → B (line 331)", () => {
    const g = grade();
    expect(g.total).toBe(g.rScore + g.executionScore + g.timingScore + g.managementScore);
    expect(g).toEqual({ overall: "B", rScore: 17, executionScore: 20, timingScore: 22, managementScore: 16, total: 75 });
  });
  it("A boundary (line 313)", () => {
    const g = grade({
      netProfit: "100",
      rMultiple: 3,
      maePips: 3,
      mfePips: 25,
      session: "LONDON",
      hour: 8,
      durationMin: 45,
      usedFVG: true,
      hitBreakeven: true,
      slippagePips: 0.3,
      postClose30m: 2,
      biasAtEntry: "WITH",
    });
    expect(g.total).toBeGreaterThanOrEqual(80);
    expect(g.overall).toBe("A");
  });
  it("each dimension max 25 (line 346) and min 0 (line 367)", () => {
    const best = grade({
      netProfit: "200",
      rMultiple: 5,
      maePips: 1,
      mfePips: 50,
      session: "LONDON",
      hour: 8,
      durationMin: 45,
      usedFVG: true,
      hitBreakeven: true,
      slippagePips: 0.1,
      postClose30m: 1,
      biasAtEntry: "WITH",
    });
    expect([best.rScore, best.executionScore, best.timingScore, best.managementScore]).toEqual([25, 25, 25, 25]);
    expect(best.total).toBe(100);
    const worst = grade({
      netProfit: "-200",
      rMultiple: -3,
      maePips: 50,
      mfePips: 1,
      session: "LATE",
      hour: 1,
      durationMin: 300,
      slippagePips: 5,
      postClose30m: 40,
      biasAtEntry: "AGAINST",
    });
    expect([worst.rScore, worst.executionScore, worst.timingScore, worst.managementScore]).toEqual([0, 3, 3, 6]);
  });
  it("grade letters A–F in order (line 414) and the boundaries", () => {
    expect(TRADE_GRADE_LETTERS).toEqual(["A", "B", "C", "D", "F"]);
    expect([80, 79, 65, 64, 50, 49, 35, 34, 0].map(gradeLetter)).toEqual(["A", "B", "B", "C", "C", "D", "D", "F", "F"]);
  });
  it("empty metrics: average duration 0 → max(0, 1) (line 423); exactly 67", () => {
    const g = grade({ rMultiple: 1 }, { ...EMPTY_METRICS });
    expect(g.total).toBeGreaterThanOrEqual(0);
    expect(g.total).toBeLessThanOrEqual(100);
    expect(g.managementScore).toBe(2 + 6);
    expect(g.total).toBe(67);
  });
  it("is deterministic (line 433)", () => {
    expect(grade({ rMultiple: 1.5, session: "NY", hour: 14 })).toEqual(grade({ rMultiple: 1.5, session: "NY", hour: 14 }));
  });
});

describe("TradeGrader ST (Greenwick TradeGrader.swift)", () => {
  const st = (o: Partial<GreenwickTrade> = {}) =>
    gradeTrade(stTrade({ netProfit: "-1", rMultiple: 0, maePoints: 0, mfePoints: 0, slippagePoints: 0, durationMin: 30, ...o }), { averageDuration: 30 }, swift);

  it("scores sessions Regular 10, Pre-market 7, After-hours 5, Extended 2 and ET hour bands", () => {
    expect(st({ session: "REGULAR", hour: 9 }).timingScore).toBe(20);
    expect(st({ session: "REGULAR", hour: 16 }).timingScore).toBe(20);
    expect(st({ session: "PRE_MARKET", hour: 11 }).timingScore).toBe(14);
    expect(st({ session: "PRE_MARKET", hour: 12 }).timingScore).toBe(14);
    expect(st({ session: "REGULAR", hour: 13 }).timingScore).toBe(17);
    expect(st({ session: "AFTER_HOURS", hour: 17 }).timingScore).toBe(6);
    expect(st({ session: "EXTENDED", hour: 4 }).timingScore).toBe(6);
    expect(st({ session: "EXTENDED", hour: 3 }).timingScore).toBe(3);
  });

  it("has no FVG or bias; execution uses points", () => {
    expect(st({ maePoints: 1, mfePoints: 5, slippagePoints: 0.2 }).executionScore).toBe(20);
    expect(st({ maePoints: 1, mfePoints: 1, slippagePoints: 0.8 }).executionScore).toBe(10);
  });

  it("scores a winner's exit by exit efficiency (> 60 → 10, > 30 → 6, else / unknown → 2)", () => {
    const win = (r: number, sl = 1) => st({ netProfit: "10", rMultiple: r, mfePoints: 2, slDistPoints: sl }).managementScore - 10;
    expect(win(1.5)).toBe(10); // 75 %
    expect(win(1.2)).toBe(6); // 60 % is not > 60
    expect(win(0.6)).toBe(2); // 30 % is not > 30
    expect(win(1.5, 0)).toBe(2); // no SL distance → nil efficiency
  });
});

describe("TradeGrader and PARITY D-18", () => {
  it("reads unknown MAE/MFE as 0 in both modes (D-18 covers averages, not grading)", () => {
    const t = makeTrade({ maePips: null, mfePips: null, slippagePips: 0.3 });
    expect(gradeTrade(t, defaultMetrics, swift).executionScore).toBe(8);
    expect(gradeTrade(t, defaultMetrics, fixed)).toEqual(gradeTrade(t, defaultMetrics, swift));
  });
});

describe("TradeGrader: journal grading and the harness key", () => {
  it("grades against the metrics of the whole set", () => {
    const ctx = createEngineContext({ brand: "dojix", now: 0 });
    const trades = [makeTrade({ durationMin: 10 }), makeTrade({ durationMin: 50 })];
    const graded = gradeTrades(ctx, trades);
    // average duration 30 → 10/30 = 0.33 → 6, 50/30 = 1.67 → 10
    expect(graded.map((g) => g.grade.managementScore)).toEqual([6 + 6, 10 + 6]);
    expect(graded[0]?.trade).toBe(trades[0]);
  });

  it("encodes TradeGrader.grades as (ticket, grade) objects", () => {
    const ctx = parityContext("dojix", 0);
    const trades = [makeTrade({ ticket: "9000000000000000123" })];
    const model = tradeGraderParity.compute(ctx, trades, undefined);
    expect(model && tradeGraderParity.members.grades?.(model, ctx)).toEqual([
      { ticket: "9000000000000000123", grade: { overall: "B", rScore: 17, executionScore: 20, timingScore: 22, managementScore: 16, total: 75 } },
    ]);
  });
});

describe("TradeGrader properties", () => {
  const num = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, 0, 1e300));
  it("always yields integer sub-scores in 0…25 and a consistent letter", () => {
    fc.assert(
      fc.property(
        fc.record({
          rMultiple: num,
          maePips: fc.option(num, { nil: null }),
          mfePips: fc.option(num, { nil: null }),
          slippagePips: num,
          slDistPips: num,
          hour: fc.integer({ min: -5, max: 30 }),
          durationMin: fc.integer({ min: -1000, max: 10_000_000 }),
          postClose30m: num,
          netProfit: fc.constantFrom("10", "-10", "0", "1e12"),
          hitBreakeven: fc.boolean(),
          usedFVG: fc.boolean(),
        }),
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.constantFrom(swift, fixed),
        (o, avgDur, ctx) => {
          const g = gradeTrade(makeTrade(o), { averageDuration: avgDur }, ctx);
          for (const s of [g.rScore, g.executionScore, g.timingScore, g.managementScore]) {
            expect(Number.isInteger(s) && s >= 0 && s <= 25).toBe(true);
          }
          expect(g.total).toBe(g.rScore + g.executionScore + g.timingScore + g.managementScore);
          expect(g.overall).toBe(gradeLetter(g.total));
        },
      ),
      { numRuns: 200 },
    );
  });
});
