import { describe, expect, it } from "vitest";
import { createEngineContext } from "../../engine/context";
import { AnalyticsRegistry } from "../../engine/registry";
import { etWall, stTrade } from "../../test-support/trades";
import { registerGreenwickOnlyComponents } from "./components";
import { catalystGroupStats, computeEarningsImpact, earningsRecommendation, tradeVolatility } from "./earnings-impact";

const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());

const trade = (openDay: number, closeDay: number, rangeSize: number, netProfit: string, maePoints: number | null = 0, symbol = "FICT") =>
  stTrade({ symbol, openTime: etWall(2026, 10, openDay, 10, 0), closeTime: etWall(2026, 10, closeDay, 15, 0), rangeSize, netProfit, maePoints });

/** 17 normal trades on 12–20 Oct and three closing on the 21st (a catalyst day). */
function sample(catalystPnL: [string, string, string] = ["100", "50", "-30"]) {
  const normal = Array.from({ length: 17 }, (_, i) => trade(12 + (i % 9), 12 + (i % 9), 1, i < 10 ? "10" : "-10"));
  const c1 = trade(21, 21, 10, catalystPnL[0]);
  const c2 = trade(20, 21, 10, catalystPnL[1], 2); // opened the day before: held through
  const c3 = trade(21, 21, 1, catalystPnL[2]); // low volatility, but closes on the catalyst day
  return { trades: [c1, c2, c3, ...normal], c1, c2, c3, normal };
}

describe("EarningsImpact (EarningsImpact.swift:42-123, 269-292)", () => {
  it("threshold = 2 × the symbol's mean volatility; catalyst = the ET close day", () => {
    const { trades, c1, c2, c3, normal } = sample();
    const m = computeEarningsImpact(trades, "swift");
    expect(m.catalystTrades).toEqual([c1, c2, c3]);
    expect(m.heldThroughTrades).toEqual([c2]);
    expect(m.normalTrades).toEqual(normal);
    expect(m.catalyst).toEqual({ count: 3, winRate: 2 / 3, avgPnL: 40, totalPnL: 120 });
    expect(m.normal).toEqual({ count: 17, winRate: 10 / 17, avgPnL: 30 / 17, totalPnL: 30 });
    expect(m.hasEnoughCatalysts).toBe(true);
    expect(m.performsBetter).toBe(true);
    expect(m.avgPnLDelta).toBeCloseTo(40 - 30 / 17, 12);
    expect(m.comparisonText).toBe("You perform better on catalyst days (+38.24 avg P&L difference)");
    expect(m.heldThroughHelped).toBe(true);
    expect(m.recommendation.label).toBe("TRADE");
    const ctx = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.run("EarningsImpact", ctx, trades)).toEqual(computeEarningsImpact(trades, "fixed"));
    expect(reg.run("EarningsImpact", ctx, trades.slice(1))).toBeNull(); // n < 20
  });

  it("AVOID and CAUTION", () => {
    const avoid = computeEarningsImpact(sample(["-100", "-50", "-30"]).trades, "swift");
    expect(avoid.recommendation).toEqual({
      label: "AVOID",
      text: "High-volatility events hurt your performance. Consider reducing size or sitting out on catalyst days. The data shows $61.76 worse per trade.",
    });
    expect(avoid.comparisonText).toBe("You perform worse on catalyst days (-61.76 avg P&L difference)");
    expect(avoid.heldThroughHelped).toBe(false);
    const caution = computeEarningsImpact(sample(["300", "-1", "-1"]).trades, "swift");
    expect(caution.recommendation.label).toBe("CAUTION"); // better average, worse win rate
    expect(earningsRecommendation(catalystGroupStats([]), catalystGroupStats([])).label).toBe("CAUTION");
  });

  it("no volatility, nothing held through", () => {
    const flat = Array.from({ length: 20 }, (_, i) => trade(12 + (i % 5), 12 + (i % 5), 0, "1"));
    const m = computeEarningsImpact(flat, "fixed");
    expect(m.catalystTrades).toEqual([]);
    expect(m.normalTrades).toHaveLength(20);
    expect(m.hasEnoughCatalysts).toBe(false);
    expect(m.heldThroughHelped).toBeNull();
    expect(m.heldThrough).toEqual({ count: 0, winRate: 0, avgPnL: 0, totalPnL: 0 });
  });

  it("D-18: volatility = max(MAE, range); an unknown MAE reads 0 on the Mac and is skipped in fixed mode", () => {
    const t = trade(12, 12, -5, "0", null);
    expect(tradeVolatility(t, "swift")).toBe(0);
    expect(tradeVolatility(t, "fixed")).toBe(-5);
    expect(tradeVolatility(trade(12, 12, 3, "0", 7), "fixed")).toBe(7);
    expect(tradeVolatility(trade(12, 12, 3, "0", 1), "swift")).toBe(3);
  });

  it("catalyst days are per symbol", () => {
    const { trades } = sample();
    const other = trade(21, 21, 1, "5", 0, "OTHR"); // same day, other symbol with flat volatility
    const m = computeEarningsImpact([...trades, other], "swift");
    expect(m.normalTrades).toContain(other);
  });
});
