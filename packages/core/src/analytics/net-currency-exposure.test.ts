import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade } from "../test-support/trades";
import { computeNetCurrencyExposure, concentrationLevelOf, netCurrencyExposureComponent, netCurrencyExposureParity } from "./net-currency-exposure";

const fx = createEngineContext({ brand: "dojix", now: 0 });

describe("NetCurrencyExposure", () => {
  const trades = [
    fxTrade({ symbol: "EURUSD", direction: "BUY", lots: 1 }),
    fxTrade({ symbol: "GBPUSD", direction: "BUY", lots: 0.5 }),
    fxTrade({ symbol: "USDJPY", direction: "SELL", lots: 0.25 }),
    fxTrade({ symbol: "EURJPY", direction: "BUY", lots: 0.25 }),
    fxTrade({ symbol: "EURUSD", direction: "SELL", lots: 0.5 }),
  ];

  it("nets lots per currency and sorts by |net|", () => {
    // EUR +1 +0.25 −0.5 = 0.75; USD −1 −0.5 −0.25 +0.5 = −1.25; GBP +0.5; JPY +0.25 −0.25 = 0
    const m = computeNetCurrencyExposure(fx, trades);
    expect(m.exposures).toEqual([
      { currency: "USD", netLots: -1.25 },
      { currency: "EUR", netLots: 0.75 },
      { currency: "GBP", netLots: 0.5 },
      { currency: "JPY", netLots: 0 },
    ]);
    expect(m.maxAbsExposure).toBe(1.25);
    expect(m.totalAbsExposure).toBe(2.5);
    expect(m.concentration).toEqual({ currency: "USD", percent: 50 });
    expect(m.concentrationLevel).toBe("none");
    expect(m.concentrationText).toBe("50% of your volume is USD-denominated");
    expect(m.netLotsText).toEqual(["-1.25", "+0.75", "+0.50", "+0.00"]);
  });

  it("finds correlated directions through ≥ 2 distinct pairs", () => {
    const m = computeNetCurrencyExposure(fx, trades);
    // USD short via EURUSD, GBPUSD (buys) and USDJPY (sell); USD long only via the EURUSD sell.
    // EUR long via EURUSD, EURJPY; EUR short only via EURUSD. JPY: one pair each way.
    // Sorted by the currency's |net|: USD 1.25, EUR 0.75.
    expect(m.correlatedInsights).toEqual([
      { currency: "USD", direction: "short", pairs: ["EURUSD", "GBPUSD", "USDJPY"] },
      { currency: "EUR", direction: "long", pairs: ["EURJPY", "EURUSD"] },
    ]);
    expect(m.insightLines).toEqual(["3x short USD via EUR/USD + GBP/USD + USD/JPY", "2x long EUR via EUR/JPY + EUR/USD"]);
  });

  it("empty input and small totals", () => {
    const empty = computeNetCurrencyExposure(fx, []);
    expect(empty).toMatchObject({ exposures: [], maxAbsExposure: 1, totalAbsExposure: 1, concentration: { currency: "--", percent: 0 } });
    expect(empty.concentrationText).toBe("0% of your volume is ---denominated");
    // AUD +0.2, NZD −0.2: total = max(0.4, 1) = 1 → 20 %; equal |net| keep first appearance
    const one = computeNetCurrencyExposure(fx, [fxTrade({ symbol: "AUDNZD", lots: 0.2 })]);
    expect(one.exposures.map((e) => e.currency)).toEqual(["AUD", "NZD"]);
    expect(one.concentration.percent).toBeCloseTo(20, 12);
    // base == quote nets to 0
    expect(computeNetCurrencyExposure(fx, [fxTrade({ symbol: "USDUSD", lots: 0.6 })]).concentration).toEqual({ currency: "USD", percent: 0 });
  });

  it("concentration can't pass 50 % (every trade adds +x and −x), so the warning levels are unreachable on the Mac too", () => {
    expect(concentrationLevelOf(50)).toBe("none");
    expect(concentrationLevelOf(50.1)).toBe("warning");
    expect(concentrationLevelOf(70)).toBe("warning");
    expect(concentrationLevelOf(70.1)).toBe("danger");
    const m = computeNetCurrencyExposure(fx, [
      fxTrade({ symbol: "EURUSD", lots: 3 }),
      fxTrade({ symbol: "EURGBP", lots: 3 }),
      fxTrade({ symbol: "EURCHF", lots: 3 }),
    ]);
    expect(m.concentration).toEqual({ currency: "EUR", percent: 50 });
  });

  it("is Dojix-only on Risk with n ≥ 5", () => {
    const reg = new AnalyticsRegistry().register(netCurrencyExposureComponent);
    expect(reg.list("dojix", "risk").map((c) => c.id)).toEqual(["NetCurrencyExposure"]);
    expect(reg.list("greenwick")).toEqual([]);
    expect(reg.run("NetCurrencyExposure", fx, trades.slice(0, 4))).toBeNull();
    expect(reg.run("NetCurrencyExposure", fx, trades)).not.toBeNull();
  });

  it("parity encodes structs and the labelled tuple", () => {
    const ctx = parityContext("dojix", 0);
    const m = netCurrencyExposureParity.compute(ctx, trades, undefined);
    expect(m && netCurrencyExposureParity.members.concentration?.(m, ctx)).toEqual({ currency: "USD", percent: 50 });
    expect(m && netCurrencyExposureParity.members.exposures?.(m, ctx)).toHaveLength(4);
    expect(m && netCurrencyExposureParity.members.correlatedInsights?.(m, ctx)).toEqual(m?.correlatedInsights);
    expect(m && netCurrencyExposureParity.members.maxAbsExposure?.(m, ctx)).toBe(1.25);
    expect(m && netCurrencyExposureParity.members.totalAbsExposure?.(m, ctx)).toBe(2.5);
    expect(netCurrencyExposureParity.compute(ctx, trades, "x")).toBeUndefined();
  });

  it("properties: no throw, no NaN for valid lots", () => {
    const sym = fc.constantFrom("EURUSD", "GBPUSD", "USDJPY", "EURJPY", "AUDNZD", "X", "");
    fc.assert(
      fc.property(
        fc.array(fc.record({ s: sym, l: fc.double({ min: 0, max: 1e6, noNaN: true }), d: fc.boolean() }), { maxLength: 20 }),
        (rows) => {
          const m = computeNetCurrencyExposure(
            fx,
            rows.map((r) => fxTrade({ symbol: r.s, lots: r.l, direction: r.d ? "BUY" : "SELL" })),
          );
          expect(Number.isNaN(m.concentration.percent)).toBe(false);
          expect(m.totalAbsExposure).toBeGreaterThanOrEqual(1);
          expect(m.concentration.percent).toBeLessThanOrEqual(50 + 1e-9);
          for (const e of m.exposures) expect(Number.isNaN(e.netLots)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.string(), fc.double()), { maxLength: 8 }), (rows) => {
        computeNetCurrencyExposure(fx, rows.map(([s, l]) => fxTrade({ symbol: s, lots: l })));
      }),
      { numRuns: 80 },
    );
  });
});
