import { describe, expect, it } from "vitest";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import { UTC_POSIX_CALENDAR } from "../time/zoned-calendar";
import { TRADING_CALENDAR } from "../time/us-market";
import {
  allEdgeConditions,
  confidenceLevel,
  edgeByBias,
  edgeByDay,
  edgeByHour,
  edgeByPair,
  edgeBySector,
  edgeBySession,
  edgeBySymbol,
  edgeByVolRegime,
  isActionable,
} from "./edges";
import { tradingDayCount } from "./trading-days";

describe("edge breakdowns — ported from Dojix MetricsCalculatorTests.swift:166-256", () => {
  it("testEdgeBySession", () => {
    const e = edgeBySession([
      fxTrade({ netProfit: "100", session: "LONDON" }),
      fxTrade({ netProfit: "50", session: "LONDON" }),
      fxTrade({ netProfit: "-30", session: "ASIAN" }),
      fxTrade({ netProfit: "80", session: "NY" }),
    ]);
    expect(e).toHaveLength(3);
    expect(e[0]).toMatchObject({ category: "Session", label: "London", profit: 150, tradeCount: 2 });
    expect(e.map((x) => x.label)).toEqual(["London", "New York", "Asian"]);
  });

  it("testEdgeByPair", () => {
    const e = edgeByPair([
      fxTrade({ symbol: "GBPUSD", netProfit: "100" }),
      fxTrade({ symbol: "GBPUSD", netProfit: "-20" }),
      fxTrade({ symbol: "EURUSD", netProfit: "50" }),
    ]);
    expect(e.map((x) => [x.label, x.profit])).toEqual([
      ["GBPUSD", 80],
      ["EURUSD", 50],
    ]);
  });

  it("testEdgeByHour (labels are H:00, not zero-padded)", () => {
    const e = edgeByHour([
      fxTrade({ netProfit: "100", hour: 10 }),
      fxTrade({ netProfit: "-30", hour: 10 }),
      fxTrade({ netProfit: "50", hour: 9 }),
    ]);
    expect(e.map((x) => [x.label, x.profit])).toEqual([
      ["10:00", 70],
      ["9:00", 50],
    ]);
  });

  it("testEdgeByDay", () => {
    const e = edgeByDay([
      fxTrade({ netProfit: "100", dayOfWeek: "Mon" }),
      fxTrade({ netProfit: "50", dayOfWeek: "Tue" }),
      fxTrade({ netProfit: "-80", dayOfWeek: "Mon" }),
    ]);
    expect(e[0]?.label).toBe("Tue");
  });

  it("testEdgeByBias / testEdgeByVolRegime", () => {
    expect(
      edgeByBias([
        fxTrade({ netProfit: "100", biasAtEntry: "WITH" }),
        fxTrade({ netProfit: "-50", biasAtEntry: "AGAINST" }),
        fxTrade({ netProfit: "30", biasAtEntry: "WITH" }),
      ])[0],
    ).toMatchObject({ label: "WITH", profit: 130 });
    const v = edgeByVolRegime([
      fxTrade({ netProfit: "80", volRegime: "MED" }),
      fxTrade({ netProfit: "-30", volRegime: "HIGH" }),
      fxTrade({ netProfit: "40", volRegime: "LOW" }),
    ]);
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ label: "MED", profit: 80 });
  });

  it("testWinRateInEdgeBreakdown", () => {
    const e = edgeBySession([
      fxTrade({ netProfit: "100" }),
      fxTrade({ netProfit: "-20" }),
      fxTrade({ netProfit: "30" }),
    ]);
    expect(e[0]?.winRate).toBeCloseTo(200 / 3, 12);
  });

  it("breaks profit ties by first appearance", () => {
    const e = edgeByPair([
      fxTrade({ symbol: "USDJPY", netProfit: "10" }),
      fxTrade({ symbol: "AUDUSD", netProfit: "10" }),
    ]);
    expect(e.map((x) => x.label)).toEqual(["USDJPY", "AUDUSD"]);
  });

  it("Greenwick symbols and sectors", () => {
    const trades = [
      stTrade({ symbol: "FICT", netProfit: "10", sector: "Technology" }),
      stTrade({ symbol: "MADE", netProfit: "-4", sector: "" }),
    ];
    expect(edgeBySymbol(trades).map((x) => [x.category, x.label])).toEqual([
      ["Symbol", "FICT"],
      ["Symbol", "MADE"],
    ]);
    expect(edgeBySector(trades).map((x) => x.label)).toEqual(["Technology", "Unknown"]);
    expect(edgeBySession(trades)[0]?.label).toBe("Regular");
  });
});

describe("confidence", () => {
  it("bands at 10 and 30", () => {
    expect([9, 10, 29, 30].map(confidenceLevel)).toEqual(["insufficient", "low", "low", "significant"]);
    expect(isActionable(29)).toBe(false);
    expect(isActionable(30)).toBe(true);
  });
});

describe("allEdgeConditions", () => {
  it("walks the Dojix dimensions in the Mac's order with full metrics", () => {
    const trades = [
      fxTrade({ netProfit: "100", hour: 9, dayOfWeek: "Mon", symbol: "EURUSD" }),
      fxTrade({ netProfit: "-50", hour: 9, dayOfWeek: "Tue", symbol: "EURUSD" }),
      fxTrade({ netProfit: "20", hour: 14, dayOfWeek: "Mon", symbol: "USDJPY" }),
    ];
    const c = allEdgeConditions(trades, 2, "dojix");
    expect([...new Set(c.map((x) => x.dimension))]).toEqual(["Hour", "Day", "Session", "Pair", "Volatility", "Bias"]);
    const h9 = c.find((x) => x.id === "Hour_9:00");
    expect(h9).toMatchObject({ profit: 50, tradeCount: 2, winRate: 50, profitFactor: 2, expectancy: 25, monthlyImpact: 50 * 10.5 });
    const h14 = c.find((x) => x.id === "Hour_14:00");
    expect(h14?.profitFactor).toBe(Infinity);
  });

  it("uses Greenwick's dimensions and the ET close weekday", () => {
    const t = stTrade({ netProfit: "125", closeTime: etWall(2026, 10, 23, 18, 50), dayOfWeek: "Fr." });
    const c = allEdgeConditions([t], 1, "greenwick");
    expect([...new Set(c.map((x) => x.dimension))]).toEqual(["Hour", "Day", "Session", "Symbol", "Sector"]);
    expect(c.filter((x) => x.dimension === "Day").map((x) => x.label)).toEqual(["Fri"]);
    expect(c.find((x) => x.dimension === "Sector")?.label).toBe("Unknown");
  });

  it("is empty without trades or trading days", () => {
    expect(allEdgeConditions([], 5, "dojix")).toEqual([]);
    expect(allEdgeConditions([fxTrade()], 0, "dojix")).toEqual([]);
    expect(allEdgeConditions([fxTrade()], NaN, "dojix")).toEqual([]);
  });
});

describe("tradingDayCount", () => {
  it("counts distinct close (or open) days on the given calendar", () => {
    const a = fxTrade({ openTime: Date.UTC(2026, 0, 14, 23), closeTime: Date.UTC(2026, 0, 15, 1) });
    const b = fxTrade({ openTime: Date.UTC(2026, 0, 15, 8), closeTime: Date.UTC(2026, 0, 15, 9) });
    expect(tradingDayCount([a, b], UTC_POSIX_CALENDAR)).toBe(1);
    expect(tradingDayCount([a, b], UTC_POSIX_CALENDAR, "open")).toBe(2); // KillZone's D-08 rule
    expect(tradingDayCount([a, b], TRADING_CALENDAR)).toBe(2); // 01:00 UTC is the previous day in New York
  });
});
