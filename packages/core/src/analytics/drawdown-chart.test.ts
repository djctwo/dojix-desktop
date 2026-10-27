import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { AnalyticsRegistry } from "../engine/registry";
import { fxSeries, fxTrade, stTrade } from "../test-support/trades";
import { computeDrawdownChart, drawdownChartComponent, drawdownChartParity } from "./drawdown-chart";
import { computeTradeComparison, tradeComparisonComponent, tradeComparisonParity } from "./trade-comparison";

describe("DrawdownChart", () => {
  it("walks ascending from 0 with dd = cum − peak (F1 tiny set)", () => {
    // F1: [100, 50, −30, −20, 80] → cum 100,150,120,100,180; dd 0,0,−30,−50,0
    const trades = fxSeries(["100", "50", "-30", "-20", "80"]).reverse(); // repository order
    const m = computeDrawdownChart(trades);
    expect(m.drawdownData.map((p) => p.drawdown)).toEqual([0, 0, -30, -50, 0]);
    expect(m.maxDrawdown).toBe(-50);
    expect(m.drawdownData[0]?.date).toBe(Date.UTC(2026, 0, 15, 10, 0));
  });

  it("starts the peak at 0, so a losing first trade is already in drawdown", () => {
    const m = computeDrawdownChart(fxSeries(["-10", "5"]));
    expect(m.drawdownData.map((p) => p.drawdown)).toEqual([-10, -5]);
    expect(computeDrawdownChart([]).maxDrawdown).toBeNull();
  });

  it("is registered for both brands with the Mac placements", () => {
    const reg = new AnalyticsRegistry().register(drawdownChartComponent);
    const st = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.list("greenwick", "risk").map((c) => c.id)).toEqual(["DrawdownChart"]);
    expect(reg.list("dojix", "overview").map((c) => c.id)).toEqual(["DrawdownChart"]);
    expect(reg.run("DrawdownChart", st, [])).toBeNull();
    expect(reg.run("DrawdownChart", st, [stTrade({ netProfit: "-3" })])).toMatchObject({ maxDrawdown: -3 });
  });

  it("encodes dates as the harness does", () => {
    const ctx = createEngineContext({ brand: "dojix", now: 0 });
    const m = drawdownChartParity.compute(ctx, fxSeries(["1"]), undefined);
    expect(m && drawdownChartParity.members.drawdownData?.(m, ctx)).toEqual([{ date: "2026-01-15T10:00:00.000Z", drawdown: 0 }]);
  });
});

describe("TradeComparison", () => {
  it("best = the first of equal maxima, worst = the first of equal minima (Swift max/min(by:))", () => {
    const a = fxTrade({ netProfit: "50" });
    const b = fxTrade({ netProfit: "-20" });
    const c = fxTrade({ netProfit: "50" });
    const d = fxTrade({ netProfit: "-20" });
    const m = computeTradeComparison([a, b, c, d]);
    expect(m.bestTrade).toBe(a);
    expect(m.worstTrade).toBe(b);
    expect(computeTradeComparison([])).toEqual({ bestTrade: null, worstTrade: null });
  });

  it("encodes trades as #ticket", () => {
    const ctx = createEngineContext({ brand: "dojix", now: 0 });
    const t = fxTrade({ ticket: "77", netProfit: "1" });
    const m = tradeComparisonParity.compute(ctx, [t], undefined);
    expect(m && tradeComparisonParity.members.bestTrade?.(m, ctx)).toBe("#77");
    expect(m && tradeComparisonParity.members.worstTrade?.(m, ctx)).toBe("#77");
    expect(tradeComparisonComponent.compute(ctx, [t])).toEqual({ bestTrade: t, worstTrade: t });
  });
});
