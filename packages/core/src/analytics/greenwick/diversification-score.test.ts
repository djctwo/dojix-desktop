import { describe, expect, it } from "vitest";
import { createEngineContext } from "../../engine/context";
import { AnalyticsRegistry } from "../../engine/registry";
import { etWall, stTrade } from "../../test-support/trades";
import { registerGreenwickOnlyComponents } from "./components";
import { computeDiversificationScore, diversificationGrade, diversificationGradeDetails, diversificationPearsonCorrelation } from "./diversification-score";

const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());
const on = (symbol: string, day: number, netProfit: string, sector = "") =>
  stTrade({ symbol, closeTime: etWall(2026, 10, day, 15, 0), netProfit, sector });

describe("DiversificationScore (DiversificationScore.swift:48-215)", () => {
  it("uncorrelated symbols: effective N = N, grade A", () => {
    // A: 1, 2, 1, 2 and B: 1, 1, 2, 2 on 19–22 Oct have correlation 0.
    const trades = [
      on("BBB", 19, "1"), on("BBB", 20, "1"), on("BBB", 21, "2"), on("BBB", 22, "2"),
      on("AAA", 19, "1"), on("AAA", 20, "2"), on("AAA", 21, "1"), on("AAA", 22, "2"),
      on("AAA", 19, "0"), on("AAA", 19, "0"),
    ];
    const m = computeDiversificationScore(trades);
    expect(m.symbols).toEqual(["AAA", "BBB"]);
    expect([...(m.symbolDailyPnL.get("AAA") ?? [])]).toEqual([["2026-10-19", 1], ["2026-10-20", 2], ["2026-10-21", 1], ["2026-10-22", 2]]);
    expect(m.correlationMatrix).toEqual([[1, 0], [0, 1]]);
    expect(m.effectivePositionCount).toBe(2);
    expect(m.ratio).toBe(1);
    expect(m.effectiveQuality).toBe("Well diversified");
    expect(m.topSymbolsByPnL).toEqual([
      { symbol: "BBB", pnl: 6, pct: 50 },
      { symbol: "AAA", pnl: 6, pct: 50 },
    ]); // equal |P&L| keeps first appearance
    expect(m.symbolWarning).toBe("Heavy concentration in BBB (50% of total P&L)");
    expect(m.sectorDistribution).toEqual([]);
    expect(m.sectorWarning).toBeNull();
    expect(m).toMatchObject({ grade: "A", gradeLabel: "Excellent" });
    expect(m.gradeDetails).toBe("Strong diversification. 100% effective independence across 2 symbols with no sector exceeding 40%.");
    const ctx = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.run("DiversificationScore", ctx, trades)).toEqual(m);
  });

  it("perfectly anti-correlated pair: effective N = 1 (grade C); sector warning", () => {
    const trades = [
      on("AAA", 19, "10", "Tech"), on("AAA", 20, "20", "Tech"), on("AAA", 21, "30", "Tech"),
      on("BBB", 19, "30", "Tech"), on("BBB", 20, "20", "Tech"), on("BBB", 21, "10", "Energy"),
    ];
    const m = computeDiversificationScore(trades);
    expect(m.correlationMatrix[0]?.[1]).toBeCloseTo(-1, 12);
    expect(m.effectivePositionCount).toBeCloseTo(1, 12);
    expect(m.grade).toBe("C");
    expect(m.effectiveQuality).toBe("Moderately diversified");
    expect(m.gradeDetails).toBe("Moderate concentration. Only 1.0 effective independent positions from 2 symbols. Returns are correlated.");
    expect(m.sectorDistribution.map((s) => [s.sector, s.count])).toEqual([["Tech", 5], ["Energy", 1]]);
    expect(m.sectorWarning).toBe("Consider diversifying beyond Tech (83% of trades)");
  });

  it("grades and their texts", () => {
    expect(diversificationGrade(0.8, 1, 41)).toBe("B"); // ratio > 0.7 but a sector above 40%
    expect(diversificationGrade(0.31, 1, 0)).toBe("C");
    expect(diversificationGrade(0.21, 1, 0)).toBe("D");
    expect(diversificationGrade(0.2, 1, 0)).toBe("F");
    expect(diversificationGrade(5, 0, 0)).toBe("F");
    expect(diversificationGradeDetails("B", 3, 5, 0)).toBe("Good spread. 60% effective independence. Minor concentration could be improved.");
    expect(diversificationGradeDetails("D", 1.25, 5, 0)).toBe("High concentration risk. Your 5 symbols behave like 1.2 independent positions. Drawdowns will be amplified.");
    expect(diversificationGradeDetails("F", 1, 5, 75)).toBe("Extreme concentration. 75% in one sector with highly correlated positions. A single adverse event could impact most of your portfolio.");
    expect(diversificationGradeDetails("F", 1, 5, 60)).toBe("Extreme concentration. Your symbols move together, providing almost no diversification benefit.");
  });

  it("correlation needs two common days and variance", () => {
    const a = new Map([["d1", 1], ["d2", 2]]);
    expect(diversificationPearsonCorrelation(a, new Map([["d1", 5]]), ["d1", "d2"])).toBe(0);
    expect(diversificationPearsonCorrelation(a, new Map([["d1", 5], ["d2", 5]]), ["d1", "d2"])).toBe(0);
    expect(diversificationPearsonCorrelation(a, new Map([["d1", 3], ["d2", 7]]), ["d1", "d2"])).toBeCloseTo(1, 12);
  });

  it("fewer than two symbols, all breakeven", () => {
    const one = computeDiversificationScore([on("AAA", 19, "0"), on("AAA", 20, "0")]);
    expect(one).toMatchObject({ symbols: ["AAA"], correlationMatrix: [[1]], effectivePositionCount: 1, topSymbolsByPnL: [] });
    const none = computeDiversificationScore([]);
    expect(none).toMatchObject({ symbols: [], correlationMatrix: [], effectivePositionCount: 0, ratio: 0, grade: "F" });
    const ctx = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.run("DiversificationScore", ctx, Array.from({ length: 10 }, () => on("AAA", 19, "1")))).toBeNull();
  });

  it("symbols sort like Swift strings and merge canonical equivalents", () => {
    const m = computeDiversificationScore([on("ﬁX", 19, "1"), on("\u{1F600}", 19, "2"), on("Zé", 19, "1"), on("Zé", 20, "1")]);
    expect(m.symbols).toEqual(["Zé", "ﬁX", "\u{1F600}"]); // U+FB01 < U+1F600 by scalar, not by UTF-16 unit
  });
});
