import { describe, expect, it } from "vitest";
import type { TradeDirection } from "../../model/enums";
import { etWall, stTrade } from "../../test-support/trades";
import { computeGapAnalysis, findGapTrades, gapStats } from "./gap-analysis";

/** A trade on 2026-03-<day> ET (after the 2026-03-08 DST switch). */
function tr(symbol: string, day: number, open: [number, number], close: [number, number], openPrice: string, closePrice: string, direction: TradeDirection = "BUY", netProfit = "0") {
  return stTrade({
    symbol,
    openTime: etWall(2026, 3, day, open[0], open[1]),
    closeTime: etWall(2026, 3, day, close[0], close[1]),
    openPrice,
    closePrice,
    direction,
    netProfit,
  });
}

describe("GapAnalysis (GapAnalysis.swift:33-171)", () => {
  it("finds gaps per symbol, fill status and the stats", () => {
    const a = tr("FICT", 9, [10, 0], [11, 0], "100", "99");
    const b = tr("FICT", 9, [13, 0], [15, 0], "99", "100"); // previous close = 100
    const c = tr("FICT", 10, [9, 35], [10, 30], "102", "103", "BUY", "50"); // +2% gap
    const d = tr("FICT", 10, [10, 0], [11, 0], "101", "100.5", "SELL", "-20"); // low 100.5 > 100: not filled
    const e = tr("FICT", 11, [9, 31], [9, 40], "100.6", "100.7"); // 0.0995% vs 100.5: not significant
    const f = tr("FAKE", 9, [10, 0], [12, 0], "51", "50");
    const g = tr("FAKE", 10, [9, 45], [11, 0], "48", "50.5", "BUY", "25"); // −4%, high 50.5 ≥ 50: filled
    const m = computeGapAnalysis([e, d, c, b, a, g, f], "en_US");

    expect(m.gapTrades.map((x) => [x.trade, x.gapType, x.gapFilled])).toEqual([
      [c, "Gap Up", false],
      [d, "Gap Up", false],
      [g, "Gap Down", true],
    ]);
    expect(m.gapTrades[0]?.gapPercent).toBeCloseTo(2, 12);
    expect(m.gapTrades[0]?.previousClose).toBe(100);
    expect(m.gapTrades[2]?.gapPercent).toBeCloseTo(-4, 12);
    expect(m.up).toEqual({ type: "Gap Up", count: 2, avgPnL: 15, winRate: 50, totalPnL: 30, fillRate: 0 });
    expect(m.down).toEqual({ type: "Gap Down", count: 1, avgPnL: 25, winRate: 100, totalPnL: 25, fillRate: 100 });
    expect(m.overallFillRate).toBe(50); // one vote per (symbol, day)
    expect(m.hasEnoughData).toBe(true);
    expect(m.bestStrategy).toBe("Need more gap trades to determine best strategy");
  });

  it("gap-and-go vs gap-and-fade", () => {
    const prev = tr("FICT", 9, [10, 0], [11, 0], "100", "100");
    const day2 = (dir: TradeDirection, pnl: string, minute: number) => tr("FICT", 10, [9, 31 + minute], [12, 0], "101", "101", dir, pnl);
    const go = computeGapAnalysis([prev, day2("BUY", "10", 0), day2("BUY", "20", 1), day2("SELL", "-5", 2)], "en_US");
    expect(go.bestStrategy).toBe("Gap-and-go works better for you (avg $15.00 vs -$5.00 fade)");
    const fade = computeGapAnalysis([prev, day2("BUY", "10", 0), day2("BUY", "20", 1), day2("SELL", "40", 2)], "en_US");
    expect(fade.bestStrategy).toBe("Gap-and-fade works better for you (avg $40.00 vs $15.00 go)");
    const same = computeGapAnalysis([prev, day2("BUY", "15", 0), day2("BUY", "15", 1), day2("SELL", "15", 2)], "en_US");
    expect(same.bestStrategy).toBe("Gap-and-go and gap-and-fade perform similarly");
    expect(fade.gapAndGoAvgPnL).toBe(15);
    expect(fade.gapAndFadeAvgPnL).toBe(40);
  });

  it("only gap-downs: nothing to compare", () => {
    const prev = tr("FICT", 9, [10, 0], [11, 0], "100", "100");
    const trades = [0, 1, 2].map((i) => tr("FICT", 10, [9, 31 + i], [12, 0], "98", "97"));
    expect(computeGapAnalysis([prev, ...trades], "en_US").bestStrategy).toBe("Need both long and short gap trades to compare strategies");
  });

  it("previous close = the last of equal close times; today's open = the first of equal open times", () => {
    const p1 = tr("FICT", 9, [10, 0], [15, 0], "100", "200");
    const p2 = tr("FICT", 9, [11, 0], [15, 0], "100", "100"); // same close time, opened later: max(by:) keeps it
    const t1 = tr("FICT", 10, [9, 31], [10, 0], "103", "103");
    const t2 = tr("FICT", 10, [9, 31], [10, 0], "50", "50"); // same open time: min(by:) keeps t1
    const gaps = findGapTrades([p1, p2, t1, t2]); // the stable sort by open time keeps t1 before t2
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.previousClose).toBe(100);
    expect(gaps[0]?.gapPercent).toBeCloseTo(3, 12);
    expect(gaps.every((g) => g.gapFilled)).toBe(true); // t2's low 50 ≤ 100
  });

  it("days come from the ET open; one day per symbol, bad prices and empty input", () => {
    // 21:00 ET on the 9th is 01:00 UTC on the 10th: still the 9th in ET.
    const late = tr("FICT", 9, [21, 0], [21, 30], "100", "100");
    const next = tr("FICT", 10, [9, 31], [10, 0], "110", "110");
    expect(findGapTrades([late, next])).toHaveLength(1);
    expect(findGapTrades([tr("FICT", 9, [10, 0], [11, 0], "1", "1")])).toEqual([]);
    expect(findGapTrades([tr("X", 9, [10, 0], [11, 0], "1", "0"), tr("X", 10, [10, 0], [11, 0], "5", "5")])).toEqual([]);
    expect(findGapTrades([tr("X", 9, [10, 0], [11, 0], "1", "1"), tr("X", 10, [10, 0], [11, 0], "oops", "5")])).toEqual([]);
    const empty = computeGapAnalysis([], "en_US");
    expect(empty).toMatchObject({ hasEnoughData: false, overallFillRate: 0, gapTrades: [] });
    expect(gapStats([], "Gap Up")).toEqual({ type: "Gap Up", count: 0, avgPnL: 0, winRate: 0, totalPnL: 0, fillRate: 0 });
  });
});
