import { describe, expect, it } from "vitest";
import { createEngineContext, parityContext } from "../../engine/context";
import { AnalyticsRegistry } from "../../engine/registry";
import { FORMULA_INDEX } from "../../formulas";
import { resolveParityOutput } from "../../parity/reference";
import { etWall, fxTrade, stTrade } from "../../test-support/trades";
import { GREENWICK_ONLY_COMPONENTS, registerGreenwickOnlyComponents } from "./components";
import { GREENWICK_ONLY_PARITY_OUTPUTS } from "./parity";

describe("Greenwick-only registry entries", () => {
  it("match FORMULA_INDEX (ids, brand, placement) and are all implemented", () => {
    const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());
    const e4 = FORMULA_INDEX.filter((f) => f.owner === "E4");
    expect(e4.map((f) => f.id).sort()).toEqual(GREENWICK_ONLY_COMPONENTS.map((c) => c.id).sort());
    for (const f of e4) {
      expect(f.status).toBe("implemented");
      expect(reg.list("greenwick", f.placement?.greenwick).map((c) => c.id)).toContain(f.id);
      expect(reg.list("dojix").map((c) => c.id)).not.toContain(f.id);
    }
    const fx = createEngineContext({ brand: "dojix", now: 0 });
    expect(reg.run("GapAnalysis", fx as never, [fxTrade()] as never)).toBeNull();
  });
});

describe("registry guards and empty states", () => {
  const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());
  const ctx = createEngineContext({ brand: "greenwick", now: 0 });
  const blank = Array.from({ length: 20 }, () => stTrade({ hour: 3, openTime: etWall(2026, 10, 23, 3, 0) }));

  it("each card's empty state is null, and data gives a model", () => {
    for (const id of ["SectorExposure", "VolumeAnalysis", "GapAnalysis", "OpeningRangeAnalysis", "ExecutionQuality", "IntradayEquityCurve", "RegimeAnalysis", "DiversificationScore"]) {
      expect(reg.run(id, ctx, blank), id).toBeNull();
    }
    expect(reg.run("EarningsImpact", ctx, blank)).toMatchObject({ hasEnoughCatalysts: false });
    const rich = Array.from({ length: 20 }, (_, i) =>
      stTrade({
        symbol: i % 2 ? "FICT" : "FAKE",
        closeTime: etWall(2026, 10, 12 + (i % 5), 15, 0),
        openTime: etWall(2026, 10, 12 + (i % 5), 10, 0),
        openPrice: String(100 + i * 3),
        closePrice: String(100 + i * 3),
        netProfit: String(i - 8),
        volume: 100,
        avgVolume: 100,
      }),
    );
    for (const id of ["VolumeAnalysis", "GapAnalysis", "OpeningRangeAnalysis", "IntradayEquityCurve"]) {
      expect(reg.run(id, ctx, rich), id).not.toBeNull();
    }
  });
});

describe("parity resolvers produce the harness's shapes", () => {
  const trades = [
    stTrade({ ticket: "900001", symbol: "FICT", sector: "Technology", closeTime: etWall(2026, 10, 19, 15, 0), netProfit: "10", maePoints: 1, slippagePoints: 0.5, volume: 100, avgVolume: 100 }),
    stTrade({ ticket: "900002", symbol: "FAKE", sector: "Energy", closeTime: etWall(2026, 10, 20, 15, 0), netProfit: "-5", maePoints: 2 }),
    stTrade({ ticket: "900003", symbol: "FICT", closeTime: etWall(2026, 10, 21, 15, 0), netProfit: "3", maePoints: 1 }),
  ];
  const ctx = parityContext("greenwick", 0);
  const get = (key: string) => resolveParityOutput(key, ctx, trades)?.value;

  it("covers every component and the keys the harness reads", () => {
    expect(Object.keys(GREENWICK_ONLY_PARITY_OUTPUTS).sort()).toEqual(GREENWICK_ONLY_COMPONENTS.map((c) => c.id).sort());
    expect(get("SectorExposure.sectorStats")).toEqual([
      { id: "Technology", sector: "Technology", totalPnL: 10, tradeCount: 1, winRate: 100 },
      { id: "Energy", sector: "Energy", totalPnL: -5, tradeCount: 1, winRate: 0 },
    ]);
    expect(get("VolumeAnalysis.tradesWithVolume")).toEqual(["#900001"]);
    expect(get("GapAnalysis.hasEnoughData")).toBe(false);
    expect(get("OpeningRangeAnalysis.bestBucket")).toMatchObject({ id: "afternoon", tradeCount: 3 }); // opened 14:30 ET
    expect(get("ExecutionQuality.worstHour")).toEqual({ id: 10, hour: 10, avgSlippage: 0.5, tradeCount: 1 });
    expect(get("ExecutionQuality.symbolSlippage")).toEqual([{ id: "FICT", symbol: "FICT", tradeCount: 1, avgSlippage: 0.5, estimatedCost: 50 }]);
    expect((get("IntradayEquityCurve.hourBuckets") as unknown[])[1]).toEqual({ id: 10, hour: 10, avgPnL: 8 / 3, tradeCount: 3, cumulativePnL: 8 / 3 });
    const days = get("RegimeAnalysis.tradingDays") as Record<string, unknown>[];
    expect(days[0]).toMatchObject({ id: "2026-10-19", date: "2026-10-19T04:00:00.000Z", trades: ["#900001"], regime: { $case: "calm", $raw: "Calm", icon: "leaf.fill" } });
    expect(get("RegimeAnalysis.currentRegime")).toMatchObject({ $raw: "Calm" });
    expect(get("RegimeAnalysis.bestRegime")).toMatchObject({ id: "Calm", dayCount: 2 });
    expect(resolveParityOutput("RegimeAnalysis.maxRegimeDays", ctx, trades)).toEqual({ value: 2, integer: true });
    expect(get("EarningsImpact.analysis")).toEqual({ catalystTrades: [], normalTrades: ["#900001", "#900002", "#900003"], heldThroughTrades: [] });
    expect(get("DiversificationScore.symbolDailyPnL")).toEqual({ FAKE: { "2026-10-20": -5 }, FICT: { "2026-10-19": 10, "2026-10-21": 3 } });
    expect(get("DiversificationScore.topSymbolsByPnL")).toEqual([
      { symbol: "FICT", pnl: 13, pct: (13 / 18) * 100 },
      { symbol: "FAKE", pnl: -5, pct: (5 / 18) * 100 },
    ]);
  });

  it("returns nothing for unknown keys or another brand", () => {
    expect(resolveParityOutput("GapAnalysis.nope", ctx, trades)).toBeUndefined();
    expect(resolveParityOutput("GapAnalysis.bestStrategy", parityContext("dojix", 0), [fxTrade()])).toBeUndefined();
  });
});
