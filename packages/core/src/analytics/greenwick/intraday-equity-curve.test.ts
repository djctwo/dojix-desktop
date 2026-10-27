import { describe, expect, it } from "vitest";
import { stTrade } from "../../test-support/trades";
import { computeIntradayEquityCurve, intradayHourLabel } from "./intraday-equity-curve";

const h = (hour: number, netProfit: string) => stTrade({ hour, netProfit });

describe("IntradayEquityCurve (IntradayEquityCurve.swift:22-82)", () => {
  it("hourly averages, cumulated; morning vs afternoon", () => {
    const m = computeIntradayEquityCurve([h(9, "100"), h(9, "50"), h(10, "-30"), h(12, "-20"), h(15, "40"), h(16, "999"), h(8, "-999")]);
    expect(m.hourBuckets.map((b) => [b.label, b.avgPnL, b.tradeCount, b.cumulativePnL])).toEqual([
      ["9:30", 75, 2, 75],
      ["10:00", -30, 1, 45],
      ["11:00", 0, 0, 45],
      ["12:00", -20, 1, 25],
      ["13:00", 0, 0, 25],
      ["14:00", 0, 0, 25],
      ["15:00", 40, 1, 65],
    ]);
    expect(m.morningPnL).toBe(120);
    expect(m.afternoonPnL).toBe(20);
    expect(m.insightText).toBe("Profitable all day -- morning is your strongest session");
    expect(m.maxAbsCumulative).toBe(75);
    expect(m.hasMarketHourTrades).toBe(true);
  });

  it("the four insights", () => {
    expect(computeIntradayEquityCurve([h(9, "10"), h(13, "-5")]).insightText).toBe("You make money in the morning and give it back after lunch");
    expect(computeIntradayEquityCurve([h(9, "-10"), h(13, "5")]).insightText).toBe("Slow start but your edge is strongest in the afternoon");
    expect(computeIntradayEquityCurve([h(9, "5"), h(13, "5")]).insightText).toBe("Profitable all day -- afternoon is your strongest session");
    expect(computeIntradayEquityCurve([h(9, "0"), h(13, "0")]).insightText).toBe("Negative P&L across both sessions -- review trade selection");
  });

  it("no market-hour trades: floor of 1 on the scale", () => {
    const m = computeIntradayEquityCurve([h(4, "0.25"), h(19, "-3")]);
    expect(m.hasMarketHourTrades).toBe(false);
    expect(m.maxAbsCumulative).toBe(1);
    expect(intradayHourLabel(14)).toBe("14:00");
  });
});
