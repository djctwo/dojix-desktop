import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import {
  computePairCorrelation,
  computeSymbolCorrelation,
  pairCorrelationComponent,
  pairCorrelationParity,
  pearsonCorrelation,
  swiftStringLess,
  symbolCorrelationComponent,
  symbolCorrelationParity,
} from "./pair-correlation";

const utc = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h);
const fx = parityContext("dojix", utc(2026, 12, 31));
const st = parityContext("greenwick", utc(2026, 12, 31));
const series = (o: Record<string, number>) => new Map(Object.entries(o));
const days = ["d1", "d2", "d3", "d4", "d5"];

describe("pearsonCorrelation (AnalyticsComponentTests.swift:153-181)", () => {
  it("perfect positive correlation → 1 (:153)", () => {
    const s = series({ d1: 10, d2: 20, d3: 30, d4: 40, d5: 50 });
    expect(pearsonCorrelation(s, s, days).correlation).toBeCloseTo(1, 3);
  });

  it("perfect negative correlation → −1 (:160)", () => {
    const a = series({ d1: 10, d2: 20, d3: 30, d4: 40, d5: 50 });
    const b = series({ d1: 50, d2: 40, d3: 30, d4: 20, d5: 10 });
    expect(pearsonCorrelation(a, b, days).correlation).toBeCloseTo(-1, 3);
  });

  it("weak correlation stays below .8 (:167)", () => {
    const a = series({ d1: 10, d2: 20, d3: 30, d4: 40, d5: 50 });
    const b = series({ d1: 5, d2: 30, d3: 10, d4: 35, d5: 15 });
    expect(Math.abs(pearsonCorrelation(a, b, days).correlation)).toBeLessThan(0.8);
  });

  it("insufficient data → 0 (:175); the component's threshold is 2 common days, not the test helper's 5", () => {
    const one = series({ d1: 10 });
    expect(pearsonCorrelation(one, one, days)).toEqual({ correlation: 0, overlap: 1 });
    const two = series({ d1: 10, d2: 20 });
    // The Swift test's own helper returns 0 here (it requires 5); PairCorrelation computes it.
    expect(pearsonCorrelation(two, two, days)).toEqual({ correlation: 1, overlap: 2 });
    // A flat series has no variance → 0
    expect(pearsonCorrelation(series({ d1: 5, d2: 5, d3: 5 }), two, days).correlation).toBe(0);
  });
});

describe("Swift String ordering", () => {
  it("compares Unicode scalars of the NFC form", () => {
    expect(swiftStringLess("AUDUSD", "EURUSD")).toBe(true);
    expect(swiftStringLess("EUR", "EURUSD")).toBe(true);
    expect(swiftStringLess("EURUSD", "EURUSD")).toBe(false);
    // U+FF21 (BMP) sorts before U+1F600 (astral) by scalar; UTF-16 code units would say otherwise
    expect(swiftStringLess("Ａ", "\u{1F600}")).toBe(true);
    expect("Ａ" < "\u{1F600}").toBe(false);
    // canonical equivalence: é precomposed == e + combining acute
    expect(swiftStringLess("é", "é")).toBe(false);
    expect(swiftStringLess("é", "é")).toBe(false);
  });
});

describe("PairCorrelation (Dojix)", () => {
  const trades = [
    fxTrade({ symbol: "GBPUSD", closeTime: utc(2026, 3, 2), netProfit: "10" }),
    fxTrade({ symbol: "EURUSD", closeTime: utc(2026, 3, 2), netProfit: "20" }),
    fxTrade({ symbol: "EURUSD", closeTime: utc(2026, 3, 2, 15), netProfit: "5" }),
    fxTrade({ symbol: "GBPUSD", closeTime: utc(2026, 3, 3), netProfit: "-10" }),
    fxTrade({ symbol: "EURUSD", closeTime: utc(2026, 3, 3), netProfit: "-30" }),
    fxTrade({ symbol: "USDJPY", closeTime: utc(2026, 3, 4), netProfit: "7" }),
  ];

  it("builds sorted pairs, daily P&L by day key and the symmetric matrix", () => {
    const m = computePairCorrelation(fx, trades);
    expect(m.pairs).toEqual(["EURUSD", "GBPUSD", "USDJPY"]);
    expect(m.pairDailyPnL.allDates).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    expect([...(m.pairDailyPnL.data.get("EURUSD") ?? [])]).toEqual([["2026-03-02", 25], ["2026-03-03", -30]]);
    expect(m.pairDailyPnL.data.get("USDJPY")?.get("2026-03-04")).toBe(7);
    const mat = m.correlationMatrix;
    expect(mat.map((r) => r.length)).toEqual([3, 3, 3]);
    expect(mat[0]?.[0]).toBe(1);
    expect(mat[0]?.[1]).toBeCloseTo(1, 12); // two points always correlate perfectly
    expect(mat[1]?.[0]).toBe(mat[0]?.[1]);
    expect(mat[0]?.[2]).toBe(0); // no common day
    expect(m.dataQualitySummary).toEqual({ sufficient: 1, total: 3, maxOverlap: 2 });
    expect(m.averageCorrelation).toBeCloseTo(1 / 3, 12);
    expect(m.insight).toEqual({ kind: "moderate", text: "Moderate correlation (avg 0.33) — reasonably diversified portfolio" });
  });

  it("uses the display calendar's day", () => {
    const tokyo = createEngineContext({ brand: "dojix", now: 0, compat: "swift", local: { tz: "Asia/Tokyo" } });
    const m = computePairCorrelation(tokyo, [fxTrade({ symbol: "EURUSD", closeTime: utc(2026, 3, 2, 20) })]);
    expect(m.pairDailyPnL.allDates).toEqual(["2026-03-03"]);
  });

  it("reports high and good diversification", () => {
    const up = (s: string, k: number) => [1, 2, 3].map((d) => fxTrade({ symbol: s, closeTime: utc(2026, 3, d), netProfit: String(d * k) }));
    expect(computePairCorrelation(fx, [...up("EURUSD", 1), ...up("GBPUSD", 2)]).insight?.kind).toBe("high");
    const good = computePairCorrelation(fx, [...up("EURUSD", 1), ...up("GBPUSD", -2)]);
    expect(good.insight).toEqual({ kind: "good", text: "Good diversification (avg -1.00) — pairs offset each other's risk" });
    const high = computePairCorrelation(fx, [...up("EURUSD", 1), ...up("GBPUSD", 2)]);
    expect(high.insight?.text).toBe("High positive correlation (avg 1.00) — concentrated risk across pairs");
  });

  it("needs two pairs: empty matrix, zero quality, no insight, empty state", () => {
    const m = computePairCorrelation(fx, [fxTrade({ symbol: "EURUSD" })]);
    expect(m.correlationMatrix).toEqual([]);
    expect(m.dataQualitySummary).toEqual({ sufficient: 0, total: 0, maxOverlap: 0 });
    expect(m.insight).toBeNull();
    expect(m.averageCorrelation).toBeNull();
    const reg = new AnalyticsRegistry().register(pairCorrelationComponent).register(symbolCorrelationComponent);
    expect(reg.run("PairCorrelation", fx, [fxTrade({ symbol: "EURUSD" })])).toBeNull();
    expect(reg.run("PairCorrelation", fx, trades)).not.toBeNull();
    expect(reg.list("dojix", "advanced").map((c) => c.id)).toEqual(["PairCorrelation"]);
    expect(reg.list("greenwick", "advanced").map((c) => c.id)).toEqual(["SymbolCorrelation"]);
  });

  it("encodes the members as the harness does", () => {
    const m = pairCorrelationParity.compute(fx, trades.slice(0, 2), undefined)!;
    expect(pairCorrelationParity.members.pairs?.(m, fx)).toEqual(["EURUSD", "GBPUSD"]);
    expect(pairCorrelationParity.members.pairDailyPnL?.(m, fx)).toEqual({
      data: { EURUSD: { "2026-03-02": 20 }, GBPUSD: { "2026-03-02": 10 } },
      allDates: ["2026-03-02"],
    });
    expect(pairCorrelationParity.members.correlationMatrix?.(m, fx)).toEqual([[1, 0], [0, 1]]);
    expect(pairCorrelationParity.members.dataQualitySummary?.(m, fx)).toEqual({ sufficient: 0, total: 1, maxOverlap: 1 });
  });
});

describe("SymbolCorrelation (Greenwick)", () => {
  it("keys days by the ET trading day of the close", () => {
    const trades = [
      stTrade({ symbol: "FICT", closeTime: etWall(2026, 10, 23, 18, 50), netProfit: "5" }), // Friday evening ET
      stTrade({ symbol: "MOCK", closeTime: etWall(2026, 10, 23, 10, 0), netProfit: "-5" }),
    ];
    const berlin = createEngineContext({ brand: "greenwick", now: 0, compat: "swift", local: { tz: "Europe/Berlin" } });
    const m = computeSymbolCorrelation(berlin, trades);
    expect(m.symbols).toEqual(["FICT", "MOCK"]);
    expect(m.symbolDailyPnL.allDates).toEqual(["2026-10-23"]);
    expect(m.dataQualitySummary).toEqual({ sufficient: 0, total: 1, maxOverlap: 1 });
    expect(m.insight?.text).toBe("Moderate correlation (avg 0.00) — reasonably diversified portfolio");
    const reg = new AnalyticsRegistry().register(symbolCorrelationComponent);
    expect(reg.run("SymbolCorrelation", st, trades)).not.toBeNull();
    expect(reg.run("SymbolCorrelation", st, trades.slice(0, 1))).toBeNull();
  });

  it("encodes the Greenwick member names", () => {
    const trades = [stTrade({ symbol: "FICT", closeTime: utc(2026, 3, 2, 15), netProfit: "1" })];
    const m = symbolCorrelationParity.compute(st, trades, undefined)!;
    expect(symbolCorrelationParity.members.symbols?.(m, st)).toEqual(["FICT"]);
    expect(symbolCorrelationParity.members.symbolDailyPnL?.(m, st)).toEqual({ data: { FICT: { "2026-03-02": 1 } }, allDates: ["2026-03-02"] });
    expect(symbolCorrelationParity.members.correlationMatrix?.(m, st)).toEqual([]);
    expect(symbolCorrelationParity.members.dataQualitySummary?.(m, st)).toEqual({ sufficient: 0, total: 0, maxOverlap: 0 });
  });
});

describe("Correlation properties", () => {
  it("is bounded in [−1, 1], symmetric, NaN-free on valid input, and never throws on hostile input", () => {
    const row = fc.record({
      s: fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "AUDUSD"),
      d: fc.integer({ min: 1, max: 6 }),
      p: fc.integer({ min: -1e9, max: 1e9 }).map((c) => String(c / 100)),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 40 }), (rows) => {
        const trades = rows.map(({ s, d, p }) => fxTrade({ symbol: s, closeTime: utc(2026, 3, d), netProfit: p }));
        const m = computePairCorrelation(fx, trades);
        m.correlationMatrix.forEach((r, i) =>
          r.forEach((v, j) => {
            expect(Number.isNaN(v)).toBe(false);
            expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-12);
            expect(m.correlationMatrix[j]?.[i]).toBe(v);
          }),
        );
        if (m.averageCorrelation !== null) expect(Number.isNaN(m.averageCorrelation)).toBe(false);
      }),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.array(fc.record({ s: fc.string(), p: fc.string(), d: fc.integer({ min: 1, max: 28 }) }), { maxLength: 25 }), (rows) => {
        const trades = rows.map(({ s, p, d }) => fxTrade({ symbol: s, closeTime: utc(2026, 2, d), netProfit: p }));
        expect(() => computePairCorrelation(fx, trades)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
