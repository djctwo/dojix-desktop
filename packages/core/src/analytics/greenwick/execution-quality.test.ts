import { describe, expect, it } from "vitest";
import { createEngineContext } from "../../engine/context";
import { AnalyticsRegistry } from "../../engine/registry";
import { stTrade } from "../../test-support/trades";
import { registerGreenwickOnlyComponents } from "./components";
import { computeExecutionQuality, executionScoreLabel, executionScoreParts } from "./execution-quality";

const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());
const ctx = createEngineContext({ brand: "greenwick", now: 0, compat: "swift" });

describe("ExecutionQuality (ExecutionQuality.swift:26-102)", () => {
  it("score, hours and symbols", () => {
    const trades = [
      ...["AAA", "BBB", "CCC", "DDD", "EEE"].map((symbol) => stTrade({ symbol, slippagePoints: 0, hour: 11 })),
      stTrade({ symbol: "AAA", slippagePoints: 1, hour: 10, shares: 100 }),
      stTrade({ symbol: "AAA", slippagePoints: 1, hour: 10, shares: 300 }),
      stTrade({ symbol: "BBB", slippagePoints: 1, hour: 10 }),
      stTrade({ symbol: "CCC", slippagePoints: 1, hour: 9 }),
      stTrade({ symbol: "DDD", slippagePoints: 1, hour: 9 }),
    ];
    const m = computeExecutionQuality(trades, "swift");
    // avg slippage 0.5 → 83.33…; σ = 0.5 → 75; no exit efficiency → 50.
    expect(m.slippageScore).toBeCloseTo((1 - 0.5 / 3) * 100, 12);
    expect(m.consistencyScore).toBe(75);
    expect(m.avgEfficiency).toBe(50);
    expect(m.executionScore).toBeCloseTo(((1 - 0.5 / 3) * 100) * 0.4 + 22.5 + 15, 12);
    expect(m.scoreLabel).toBe("Good");
    expect(m.tradesWithSlippage).toHaveLength(5);
    expect(m.hourlySlippage).toEqual([
      { hour: 9, avgSlippage: 1, tradeCount: 2 },
      { hour: 10, avgSlippage: 1, tradeCount: 3 },
    ]);
    expect(m.worstHour?.hour).toBe(10); // max(by:) keeps the last tie
    expect(m.maxHourlySlippage).toBe(1);
    expect(m.symbolSlippage.map((s) => s.symbol)).toEqual(["AAA", "BBB", "CCC", "DDD"]);
    expect(m.symbolSlippage[0]).toEqual({ symbol: "AAA", tradeCount: 2, avgSlippage: 1, estimatedCost: 200 });
    expect(reg.run("ExecutionQuality", ctx, trades)).toEqual(m);
    expect(reg.run("ExecutionQuality", ctx, trades.slice(0, 9))).toBeNull(); // n < 10
  });

  it("top 5 symbols by average slippage, exit efficiency, clamps", () => {
    const syms = ["S1", "S2", "S3", "S4", "S5", "S6"];
    const trades = syms.map((symbol, i) => stTrade({ symbol, slippagePoints: 1 + i, mfePoints: 4, slDistPoints: 2, rMultiple: 1 }));
    const m = computeExecutionQuality(trades, "fixed");
    expect(m.symbolSlippage.map((s) => s.symbol)).toEqual(["S6", "S5", "S4", "S3", "S2"]);
    expect(m.avgEfficiency).toBe(50); // 1R × 2 pts of a 4-pt MFE
    expect(m.slippageScore).toBe(0); // avg 3.5 pts → clamped
    expect(m.consistencyScore).toBeCloseTo((1 - Math.sqrt(35 / 12) / 2) * 100, 12);
  });

  it("labels and edge cases", () => {
    expect(executionScoreLabel(70.0001)).toBe("Good");
    expect(executionScoreLabel(70)).toBe("Fair");
    expect(executionScoreLabel(40)).toBe("Fair");
    expect(executionScoreLabel(39.99)).toBe("Poor");
    expect(executionScoreParts([], "swift").executionScore).toBe(0);
    const none = Array.from({ length: 10 }, () => stTrade({ slippagePoints: -0.5 }));
    const m = computeExecutionQuality(none, "swift");
    expect(m.tradesWithSlippage).toEqual([]);
    expect(m.worstHour).toBeNull();
    expect(m.maxHourlySlippage).toBe(1);
    expect(m.slippageScore).toBe(100); // price improvement clamps at 100
    expect(reg.run("ExecutionQuality", ctx, none)).toBeNull();
  });
});
