import { describe, expect, it } from "vitest";
import { etWall, stTrade } from "../../test-support/trades";
import { computeOpeningRange, minutesSinceOpen } from "./opening-range";

const at = (h: number, m: number, netProfit: string, day = 23) => stTrade({ openTime: etWall(2026, 10, day, h, m), closeTime: etWall(2026, 10, day, 16, 30), netProfit });

describe("OpeningRangeAnalysis (OpeningRangeAnalysis.swift:22-102)", () => {
  it("minutes after 09:30 ET of the open; regular session only", () => {
    expect(minutesSinceOpen(at(9, 30, "0"))).toBe(0);
    expect(minutesSinceOpen(at(15, 59, "0"))).toBe(389);
    expect(minutesSinceOpen(at(9, 29, "0"))).toBeNull();
    expect(minutesSinceOpen(at(16, 0, "0"))).toBeNull();
    expect(minutesSinceOpen(at(10, 0, "0", 24))).toBe(30); // Saturday: not excluded, as on the Mac
  });

  it("buckets, best/worst and the insight", () => {
    const trades = [at(9, 30, "100"), at(9, 34, "-20"), at(9, 35, "-60"), at(12, 0, "10"), at(15, 59, "30"), at(8, 0, "999")];
    const m = computeOpeningRange(trades);
    expect(m.buckets.map((b) => [b.id, b.tradeCount, b.totalPnL])).toEqual([
      ["5min", 2, 80],
      ["15min", 1, -60],
      ["30min", 0, 0],
      ["midmorn", 0, 0],
      ["lunch", 1, 10],
      ["afternoon", 0, 0],
      ["power", 1, 30],
    ]);
    expect(m.buckets[0]).toMatchObject({ label: "First 5 min", avgPnL: 40, winRate: 50 });
    expect(m.activeBuckets.map((b) => b.id)).toEqual(["5min", "15min", "lunch", "power"]);
    expect(m.bestBucket?.id).toBe("5min");
    expect(m.worstBucket?.id).toBe("15min");
    expect(m.insightText).toBe("Your best entries are first 5 min (+$40.00 avg) — first 15 min costs you $60.00");
  });

  it("ties: best is the last maximum, worst the first minimum; no cost clause when the worst total is ≥ 0", () => {
    const m = computeOpeningRange([at(9, 31, "10"), at(9, 40, "10"), at(10, 0, "5")]);
    expect(m.bestBucket?.id).toBe("15min");
    expect(m.worstBucket?.id).toBe("midmorn");
    expect(m.insightText).toBe("Your best entries are first 15 min (+$10.00 avg)");
    const neg = computeOpeningRange([at(9, 31, "-10"), at(10, 0, "-5")]);
    expect(neg.insightText).toBe("Your best entries are mid-morning (-$5.00 avg) — first 5 min costs you $10.00");
  });

  it("one active bucket and none", () => {
    expect(computeOpeningRange([at(9, 31, "1")]).insightText).toBe("Need more trades across different times for insights");
    const none = computeOpeningRange([at(7, 0, "1")]);
    expect(none).toMatchObject({ hasData: false, bestBucket: null, worstBucket: null, activeBuckets: [] });
    expect(none.insightText).toBe("Need more trades across different times for insights");
  });
});
