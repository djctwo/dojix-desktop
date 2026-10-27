import { describe, expect, it } from "vitest";
import { stTrade } from "../../test-support/trades";
import { computeVolumeAnalysis, relativeVolume } from "./volume-analysis";

const v = (volume: number, netProfit: string) => stTrade({ volume, avgVolume: 1000, netProfit });

describe("VolumeAnalysis (VolumeAnalysis.swift:19-72)", () => {
  it("closed buckets share their edges; RVOL above 1000 falls in none", () => {
    const trades = [v(250, "10"), v(500, "-20"), v(1000, "30"), v(1500, "40"), v(3000, "-50"), v(2_000_000, "60"), stTrade({ volume: 0, avgVolume: 5 })];
    const m = computeVolumeAnalysis(trades, "en_US");
    expect(m.hasVolumeData).toBe(true);
    expect(m.tradesWithVolume).toHaveLength(6);
    expect(m.buckets.map((b) => [b.id, b.tradeCount, b.totalPnL])).toEqual([
      ["low", 2, -10],
      ["normal", 3, 50],
      ["high", 2, -10],
      ["vhigh", 1, -50],
    ]);
    expect(m.buckets[1]).toMatchObject({ label: "Normal (0.5-1.5x)", avgPnL: 50 / 3, winRate: (2 / 3) * 100 });
    // Insight: RVOL > 1.5 strictly (3, 2000) vs < 0.5 strictly (0.25).
    expect(m.highVolumeCount).toBe(2);
    expect(m.highVolumeAvgPnL).toBe(5);
    expect(m.lowVolumeCount).toBe(1);
    expect(m.insightText).toBe("Trades on high relative volume days average +$5.00 vs +$10.00 on low volume");
  });

  it("negative averages print without a plus sign", () => {
    const m = computeVolumeAnalysis([v(100, "-12.5"), v(5000, "-1")], "en_US");
    expect(m.insightText).toBe("Trades on high relative volume days average -$1.00 vs -$12.50 on low volume");
  });

  it("all normal volume, and no volume data", () => {
    expect(computeVolumeAnalysis([v(1000, "1")], "en_US").insightText).toBe("Most trades occur at normal relative volume");
    const empty = computeVolumeAnalysis([stTrade()], "en_US");
    expect(empty.hasVolumeData).toBe(false);
    expect(empty.buckets.every((b) => b.tradeCount === 0 && b.avgPnL === 0 && b.winRate === 0)).toBe(true);
    expect(relativeVolume({ volume: 5, avgVolume: 0 })).toBe(0);
  });
});
