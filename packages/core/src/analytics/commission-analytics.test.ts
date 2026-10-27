import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxTrade, stTrade } from "../test-support/trades";
import { commissionAnalyticsComponent, commissionAnalyticsParity, computeCommissionAnalytics } from "./commission-analytics";

const fx = createEngineContext({ brand: "dojix", now: 0 });
const st = createEngineContext({ brand: "greenwick", now: 0 });

describe("CommissionAnalytics", () => {
  it("Dojix: totals, gross of winners, cost % and per-lot costs", () => {
    const trades = [
      fxTrade({ symbol: "EURUSD", netProfit: "100", commission: "-7", swap: "-1", lots: 1 }),
      fxTrade({ symbol: "GBPUSD", netProfit: "-40", commission: "-3.5", swap: "0", lots: 0.5 }),
      fxTrade({ symbol: "EURUSD", netProfit: "60", commission: "-7", swap: "2", lots: 1 }),
      fxTrade({ symbol: "USDJPY", netProfit: "0", commission: "0", swap: "0", lots: 0 }),
    ];
    const m = computeCommissionAnalytics(fx, trades);
    expect(m.hasCostData).toBe(true);
    expect(m.totalCommissions).toBe(-17.5);
    expect(m.totalSwap).toBe(1);
    expect(m.totalCosts).toBe(-16.5);
    expect(m.avgCostPerTrade).toBe(-16.5 / 4);
    expect(m.grossProfit).toBe(160);
    expect(m.costPercent).toBeCloseTo((16.5 / 160) * 100, 12);
    expect(m.costLevel).toBe("yellow");
    expect(m.insightText).toBe("Costs consume 10.3% of gross profit");
    expect(m.symbolCosts).toEqual([
      { symbol: "EURUSD", totalCosts: -13, totalSize: 2, costPerUnit: 6.5 },
      { symbol: "GBPUSD", totalCosts: -3.5, totalSize: 0.5, costPerUnit: 7 },
      { symbol: "USDJPY", totalCosts: 0, totalSize: 0, costPerUnit: 0 },
    ]);
  });

  it("Greenwick: gross = net + costs per trade, per share", () => {
    const trades = [
      stTrade({ symbol: "AAAA", netProfit: "95", commission: "5", swap: "0", shares: 100 }),
      stTrade({ symbol: "BBBB", netProfit: "-2", commission: "4", swap: "1", shares: 50 }), // gross +3
      stTrade({ symbol: "AAAA", netProfit: "-20", commission: "5", swap: "0", shares: 100 }), // gross −15
    ];
    const m = computeCommissionAnalytics(st, trades);
    expect(m.grossProfit).toBe(103);
    expect(m.totalCosts).toBe(15);
    expect(m.costPercent).toBeCloseTo((15 / 103) * 100, 12);
    expect(m.costLevel).toBe("yellow");
    expect(m.symbolCosts[0]).toEqual({ symbol: "AAAA", totalCosts: 10, totalSize: 200, costPerUnit: 0.05 });
  });

  it("levels, no gross profit, empty input and ties", () => {
    expect(computeCommissionAnalytics(fx, [fxTrade({ netProfit: "1000", commission: "-1" })]).costLevel).toBe("green");
    expect(computeCommissionAnalytics(fx, [fxTrade({ netProfit: "10", commission: "-5" })]).costLevel).toBe("red");
    expect(computeCommissionAnalytics(fx, [fxTrade({ netProfit: "-10", commission: "-5" })]).costPercent).toBe(0);
    const empty = computeCommissionAnalytics(fx, []);
    expect(empty).toMatchObject({ hasCostData: false, avgCostPerTrade: 0, costPercent: 0, symbolCosts: [] });
    // equal |costs|: first appearance wins (the Mac's dictionary order is random)
    const tie = computeCommissionAnalytics(fx, [
      fxTrade({ symbol: "ZZZAAA", commission: "-2" }),
      fxTrade({ symbol: "AAAZZZ", commission: "2" }),
    ]);
    expect(tie.symbolCosts.map((s) => s.symbol)).toEqual(["ZZZAAA", "AAAZZZ"]);
  });

  it("is registered on Risk and hidden without cost data", () => {
    const reg = new AnalyticsRegistry().register(commissionAnalyticsComponent);
    expect(reg.list("dojix", "risk").map((c) => c.id)).toEqual(["CommissionAnalytics"]);
    expect(reg.list("greenwick", "risk").map((c) => c.id)).toEqual(["CommissionAnalytics"]);
    expect(reg.run("CommissionAnalytics", fx, [fxTrade()])).toBeNull();
    expect(reg.run("CommissionAnalytics", fx, [fxTrade({ swap: "0.5" })])).toMatchObject({ totalSwap: 0.5 });
  });

  it("parity: SymbolCost encodes per brand", () => {
    const fxc = parityContext("dojix", 0);
    const stc = parityContext("greenwick", 0);
    const fm = commissionAnalyticsParity.compute(fxc, [fxTrade({ symbol: "EURUSD", commission: "-2", lots: 0.5 })], undefined);
    expect(fm && commissionAnalyticsParity.members.symbolCosts?.(fm, fxc)).toEqual([
      { symbol: "EURUSD", totalCosts: -2, totalLots: 0.5, costPerLot: 4 },
    ]);
    const sm = commissionAnalyticsParity.compute(stc, [stTrade({ symbol: "CCCC", commission: "1", shares: 10 })], undefined);
    expect(sm && commissionAnalyticsParity.members.symbolCosts?.(sm, stc)).toEqual([
      { symbol: "CCCC", totalCosts: 1, totalShares: 10, costPerShare: 0.1 },
    ]);
    for (const k of ["hasCostData", "totalCommissions", "totalSwap", "totalCosts", "avgCostPerTrade", "grossProfit", "costPercent"]) {
      expect(sm && commissionAnalyticsParity.members[k]?.(sm, stc)).toBe((sm as unknown as Record<string, unknown>)[k]);
    }
    expect(commissionAnalyticsParity.compute(stc, [], "x")).toBeUndefined();
  });

  it("properties: no throw; no NaN for storage-valid input", () => {
    const money = fc.integer({ min: -100_000_000, max: 100_000_000 }).map((c) => (c / 100).toString());
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: money, c: money, s: money, q: fc.double({ min: 0, max: 1e6, noNaN: true }) }), { maxLength: 15 }),
        fc.boolean(),
        (rows, greenwick) => {
          const ctx = greenwick ? st : fx;
          const trades = rows.map((r, i) =>
            greenwick
              ? stTrade({ symbol: `S${i % 3}`, netProfit: r.p, commission: r.c, swap: r.s, shares: r.q })
              : fxTrade({ symbol: `P${i % 3}`, netProfit: r.p, commission: r.c, swap: r.s, lots: r.q }),
          );
          const m = computeCommissionAnalytics(ctx, trades);
          for (const v of Object.values(m)) if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
          for (const s of m.symbolCosts) expect(Number.isNaN(s.costPerUnit)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 6 }), (xs) => {
        computeCommissionAnalytics(fx, xs.map((x) => fxTrade({ commission: x, netProfit: x, lots: Number.NaN })));
      }),
      { numRuns: 50 },
    );
  });
});
