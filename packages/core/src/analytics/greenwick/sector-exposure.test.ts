import { describe, expect, it } from "vitest";
import { createEngineContext } from "../../engine/context";
import { AnalyticsRegistry } from "../../engine/registry";
import { stTrade } from "../../test-support/trades";
import { registerGreenwickOnlyComponents } from "./components";
import { computeSectorExposure } from "./sector-exposure";

const ctx = createEngineContext({ brand: "greenwick", now: 0 });
const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());

describe("SectorExposure (SectorExposure.swift:17-56)", () => {
  it("groups by sector, sorts by |P&L| and warns above 50%", () => {
    const trades = [
      stTrade({ sector: "Technology", netProfit: "100" }),
      stTrade({ sector: "Technology", netProfit: "-50" }),
      stTrade({ sector: "Energy", netProfit: "-200" }),
      stTrade({ sector: "", netProfit: "30" }),
    ];
    const m = computeSectorExposure(trades);
    expect(m.hasSectorData).toBe(true);
    expect(m.sectorStats).toEqual([
      { sector: "Energy", totalPnL: -200, tradeCount: 1, winRate: 0 },
      { sector: "Technology", totalPnL: 50, tradeCount: 2, winRate: 50 },
    ]);
    expect(m.maxAbsPnL).toBe(200);
    expect(m.totalPnL).toBe(-150);
    expect(m.concentration?.sector).toBe("Technology");
    expect(m.concentration?.pct).toBeCloseTo(200 / 3, 12);
    expect(m.concentrationWarning).toBe("Technology accounts for 67% of trades — consider diversifying");
    expect(reg.run("SectorExposure", ctx, trades)).toEqual(m);
  });

  it("no warning at exactly 50%; equal |P&L| keeps first appearance", () => {
    const m = computeSectorExposure([
      stTrade({ sector: "Energy", netProfit: "10" }),
      stTrade({ sector: "Utilities", netProfit: "-10" }),
    ]);
    expect(m.concentrationWarning).toBeNull();
    expect(m.sectorStats.map((s) => s.sector)).toEqual(["Energy", "Utilities"]);
  });

  it("empty state without sector data", () => {
    const trades = [stTrade({ netProfit: "5" })];
    const m = computeSectorExposure(trades);
    expect(m).toMatchObject({ hasSectorData: false, sectorStats: [], maxAbsPnL: 1, concentrationWarning: null, totalPnL: 0 });
    expect(reg.run("SectorExposure", ctx, trades)).toBeNull();
  });

  it("canonically equivalent sector names are one group (Swift String equality)", () => {
    const m = computeSectorExposure([
      stTrade({ sector: "Café", netProfit: "1" }),
      stTrade({ sector: "Café", netProfit: "2" }),
    ]);
    expect(m.sectorStats).toHaveLength(1);
    expect(m.sectorStats[0]).toMatchObject({ sector: "Café", tradeCount: 2, totalPnL: 3 });
  });
});
