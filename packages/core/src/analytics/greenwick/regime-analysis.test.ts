import { describe, expect, it } from "vitest";
import { createEngineContext } from "../../engine/context";
import { AnalyticsRegistry } from "../../engine/registry";
import { etWall, stTrade } from "../../test-support/trades";
import { registerGreenwickOnlyComponents } from "./components";
import { classifyRegime, computeRegimeAnalysis, medianOf } from "./regime-analysis";

const reg = registerGreenwickOnlyComponents(new AnalyticsRegistry());
const on = (day: number, netProfit: string, maePoints: number | null = 1) =>
  stTrade({ closeTime: etWall(2026, 10, day, 15, 0), netProfit, maePoints });

/** Trending, Choppy, Volatile, Calm on 19–22 Oct 2026 (10 trades). */
function fourDays(d3mae: number | null = 20, d4mae: number | null = 1, d12mae: number | null = 1) {
  return [
    on(19, "300", d12mae), on(19, "200", d12mae), on(19, "-100", d12mae),
    on(20, "-50", d12mae), on(20, "-50", d12mae), on(20, "10", d12mae),
    on(21, "10", d3mae), on(21, "-10", d3mae),
    on(22, "10", d4mae), on(22, "-10", d4mae),
  ];
}

describe("RegimeAnalysis (RegimeAnalysis.swift:63-185)", () => {
  it("classifies each ET close day and summarises by regime", () => {
    const m = computeRegimeAnalysis([...fourDays()].reverse(), "swift");
    expect(m.medianDayMAE).toBe(1);
    expect(m.tradingDays.map((d) => [d.dayKey, d.regime])).toEqual([
      ["2026-10-19", "Trending"],
      ["2026-10-20", "Choppy"],
      ["2026-10-21", "Volatile"],
      ["2026-10-22", "Calm"],
    ]);
    expect(m.tradingDays[0]).toMatchObject({ winRate: (2 / 3) * 100, avgWinner: 250, avgLoser: 100, totalPnL: 400, avgMAE: 1 });
    expect(m.tradingDays[0]?.date).toBe(etWall(2026, 10, 19, 0, 0));
    expect(m.regimeStats.map((s) => [s.regime, s.dayCount, s.totalPnL, s.avgPnL])).toEqual([
      ["Trending", 1, 400, 400],
      ["Choppy", 1, -90, -90],
      ["Volatile", 1, 0, 0],
      ["Calm", 1, 0, 0],
    ]);
    expect(m.regimeStats[0]?.winRate).toBeCloseTo((2 / 3) * 100, 12);
    expect(m.bestRegime?.regime).toBe("Trending");
    expect(m.worstRegime?.regime).toBe("Choppy");
    expect(m.currentRegime).toBe("Calm"); // four-way tie: the last regime to appear (desktop tie-break)
    expect(m.maxRegimeDays).toBe(1);
    expect(m.bestInsight).toBe("You thrive in Trending days -- avg $400.00/day across 1 days");
    expect(m.worstInsight).toBe("Consider sitting out Choppy days -- costs you $90.00 total");
    expect(m.needsMoreVariety).toBe(false);
  });

  it("current regime = the most common of the last five days", () => {
    const calm = (day: number) => [on(day, "10"), on(day, "-10")];
    const choppy = (day: number) => [on(day, "-10"), on(day, "-10")];
    const trades = [...choppy(12), ...choppy(13), ...calm(14), ...calm(15), ...choppy(16), ...calm(19), ...calm(20)];
    const m = computeRegimeAnalysis(trades, "fixed");
    expect(m.tradingDays).toHaveLength(7);
    expect(m.currentRegime).toBe("Calm"); // last five days: 14, 15, 16, 19, 20 = Calm ×4, Choppy ×1
    expect(m.bestInsight).toBeNull(); // Calm average 0
    expect(m.worstRegime?.regime).toBe("Choppy");
  });

  it("D-18: unknown MAE counts as 0 on the Mac, is skipped in fixed mode", () => {
    const trades = fourDays(3, 1, null);
    const swift = computeRegimeAnalysis(trades, "swift");
    expect(swift.medianDayMAE).toBe(0.5); // [0, 0, 1, 3]
    expect(swift.tradingDays[2]?.regime).toBe("Volatile");
    const fixed = computeRegimeAnalysis(trades, "fixed");
    expect(fixed.medianDayMAE).toBe(2); // [1, 3]
    expect(fixed.tradingDays[2]?.regime).toBe("Calm");
    expect(fixed.tradingDays[0]?.avgMAE).toBeNull();
  });

  it("guards: 10 trades and 3 days", () => {
    const ctx = createEngineContext({ brand: "greenwick", now: 0 });
    expect(reg.run("RegimeAnalysis", ctx, fourDays().slice(0, 9))).toBeNull();
    expect(reg.run("RegimeAnalysis", ctx, fourDays())).not.toBeNull();
    const twoDays = Array.from({ length: 10 }, (_, i) => on(19 + (i % 2), "1"));
    expect(reg.run("RegimeAnalysis", ctx, twoDays)).toBeNull();
    const empty = computeRegimeAnalysis([], "swift");
    expect(empty).toMatchObject({ tradingDays: [], bestRegime: null, worstRegime: null, currentRegime: null, maxRegimeDays: 1, needsMoreVariety: true });
  });

  it("classifier rules and median", () => {
    expect(classifyRegime(61, 151, 100, 0, 0)).toBe("Trending");
    expect(classifyRegime(61, 150, 100, 0, 0)).toBe("Calm"); // not > 1.5×
    expect(classifyRegime(100, 10, 0, 0, 0)).toBe("Calm"); // no losers: avgLoser 0 is not Trending
    expect(classifyRegime(39.9, 0, 0, 0, 0)).toBe("Choppy");
    expect(classifyRegime(50, 0, 0, 2.1, 1)).toBe("Volatile");
    expect(classifyRegime(50, 0, 0, 2, 1)).toBe("Calm");
    expect(classifyRegime(50, 0, 0, null, 1)).toBe("Calm");
    expect(medianOf([])).toBe(0);
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });
});
