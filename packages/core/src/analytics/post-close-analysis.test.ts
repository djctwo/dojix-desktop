import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { computePostCloseAnalysis, postCloseAnalysisComponent, postCloseAnalysisParity } from "./post-close-analysis";

const fx = createEngineContext({ brand: "dojix", now: 0, compat: "swift" });

describe("PostCloseAnalysis", () => {
  it("early exits: 5 of 10 wins with > 10 pips continuation = 50 % (AnalyticsComponentTests.swift:185-200)", () => {
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => fxTrade({ ticket: `${i}`, netProfit: "50", postClose30m: 15 })),
      ...Array.from({ length: 5 }, (_, i) => fxTrade({ ticket: `${5 + i}`, netProfit: "50", postClose30m: 5 })),
    ];
    const m = computePostCloseAnalysis(trades);
    expect(m.earlyExitPercent).toBeCloseTo(50, 2);
    expect(m.earlyExitCount).toBe(5);
    expect(m.insight).toEqual({ kind: "trailingStops", text: "Consider trailing stops — 50% of wins had 10+ pips continuation" });
  });

  it("averages post-close over all trades (AnalyticsComponentTests.swift:202-216)", () => {
    const trades = [
      fxTrade({ ticket: "1", netProfit: "50", postClose15m: 10, postClose30m: 20 }),
      fxTrade({ ticket: "2", netProfit: "50", postClose15m: 5, postClose30m: 15 }),
      fxTrade({ ticket: "3", netProfit: "-30", postClose15m: 3, postClose30m: 8 }),
    ];
    const m = computePostCloseAnalysis(trades);
    expect(m.avgPostClose15m).toBeCloseTo(6.0, 2);
    expect(m.avgPostClose30m).toBeCloseTo(14.333, 2);
    expect(m.winContinuation).toEqual([
      { label: "Winners", timeframe: "15m", avgPips: 7.5 },
      { label: "Winners", timeframe: "30m", avgPips: 17.5 },
    ]);
    expect(m.lossContinuation).toEqual([
      { label: "Losers", timeframe: "15m", avgPips: 3 },
      { label: "Losers", timeframe: "30m", avgPips: 8 },
    ]);
  });

  it("breakevens are in the averages but neither side; 'good timing' when avg30 < 0", () => {
    const m = computePostCloseAnalysis([fxTrade({ netProfit: "0", postClose15m: -1, postClose30m: -2 })]);
    expect(m).toMatchObject({ avgPostClose30m: -2, earlyExitPercent: 0, winContinuation: [], lossContinuation: [] });
    expect(m.insight?.kind).toBe("goodTiming");
    expect(computePostCloseAnalysis([fxTrade({ netProfit: "1", postClose30m: 3 })]).insight).toBeNull();
    expect(computePostCloseAnalysis([])).toMatchObject({ avgPostClose15m: 0, avgPostClose30m: 0, earlyExitCount: 0, insight: null });
  });

  it("is Dojix only, on the Edge Report, empty without trades", () => {
    const reg = new AnalyticsRegistry().register(postCloseAnalysisComponent);
    expect(reg.list("dojix", "edgeReport").map((c) => c.id)).toEqual(["PostCloseAnalysis"]);
    expect(reg.list("greenwick")).toEqual([]);
    expect(reg.run("PostCloseAnalysis", fx, [])).toBeNull();
    expect(reg.run("PostCloseAnalysis", fx, [fxTrade({ netProfit: "2", postClose30m: 12 })])).toMatchObject({ earlyExitCount: 1 });
    expect(reg.run("PostCloseAnalysis", createEngineContext({ brand: "greenwick", now: 0 }), [stTrade()])).toBeNull();
  });

  it("encodes ContinuationData without the UUID", () => {
    const m = postCloseAnalysisParity.compute(fx, [fxTrade({ netProfit: "1", postClose15m: 2, postClose30m: 4 })], undefined);
    if (!m) throw new Error("no model");
    const get = (k: string) => postCloseAnalysisParity.members[k]?.(m, fx);
    expect(get("winContinuation")).toEqual([
      { label: "Winners", timeframe: "15m", avgPips: 2 },
      { label: "Winners", timeframe: "30m", avgPips: 4 },
    ]);
    expect(get("lossContinuation")).toEqual([]);
    expect([get("avgPostClose15m"), get("avgPostClose30m"), get("earlyExitCount"), get("earlyExitPercent")]).toEqual([2, 4, 0, 0]);
  });

  it("no NaN for valid trades", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: fc.integer({ min: -1e6, max: 1e6 }), a: fc.double({ min: -1e6, max: 1e6, noNaN: true }), b: fc.double({ min: -1e6, max: 1e6, noNaN: true }) }), { maxLength: 20 }),
        (rows) => {
          const m = computePostCloseAnalysis(rows.map((r) => fxTrade({ netProfit: String(r.p), postClose15m: r.a, postClose30m: r.b })));
          for (const v of [m.avgPostClose15m, m.avgPostClose30m, m.earlyExitPercent, ...m.winContinuation.map((c) => c.avgPips), ...m.lossContinuation.map((c) => c.avgPips)]) {
            expect(Number.isNaN(v)).toBe(false);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
