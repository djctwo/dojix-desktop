// Sessions tab: RMultipleChart, PerformanceSummary, StreakTimeline, SessionHeatmap,
// SessionIntelligence, SequenceAnalysis, WhatToCutAdvisor, KillZoneOptimizer, PeriodComparison.
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { streaksOf } from "../metrics/metrics-calculator";
import type { DojixTrade, Trade } from "../model/trade";
import { etWall, fxSeries, fxTrade, stTrade } from "../test-support/trades";
import { killZoneCsvRows, killZoneOptimizer } from "./kill-zone";
import { performanceSummary, sparklineBarHeight } from "./performance-summary";
import { percentChange, periodComparison } from "./period-comparison";
import { rMultipleChart, rMultipleLabel } from "./r-multiple";
import { SEQUENCE_INSIGHT, sequenceAnalysis, sequencePattern } from "./sequence-analysis";
import { sessionHeatmap, sessionHeatmapOpacity } from "./session-heatmap";
import { sessionIntelligence, sessionRecommendation } from "./session-intelligence";
import { streakTimeline } from "./streak-timeline";
import { whatToCut, whatToCutCsvRows } from "./what-to-cut";

const NOW = Date.UTC(2026, 9, 21, 12, 0); // Wednesday
const fx = createEngineContext({ brand: "dojix", now: NOW, compat: "swift" });
const fxFixed = createEngineContext({ brand: "dojix", now: NOW, compat: "fixed" });
const st = createEngineContext({ brand: "greenwick", now: NOW, compat: "swift" });
const DAY = 86_400_000;

describe("RMultipleChart", () => {
  it("buckets R in half-open ranges and labels them like the Mac", () => {
    const rs = [-150, -50, -2, -1.75, -0.5, 0, 0.25, 1.99, 2, 99.99, 100];
    const m = rMultipleChart(fx, rs.map((r) => fxTrade({ rMultiple: r })));
    expect(m.buckets).toEqual([
      { range: "<-2R", count: 1, midpoint: -51 },
      { range: "-2.0R", count: 2, midpoint: -1.75 },
      { range: "-0.5R", count: 1, midpoint: -0.25 },
      { range: "0.0R", count: 2, midpoint: 0.25 },
      { range: "1.5R", count: 1, midpoint: 1.75 },
      { range: ">2R", count: 2, midpoint: 51 },
    ]);
    expect(m.bestR).toBe(100);
    expect(m.worstR).toBe(-150);
    expect(m.medianR).toBe(0);
    expect(m.avgR).toBeCloseTo(rs.reduce((a, b) => a + b, 0) / rs.length, 12);
    expect(m.hasTrades).toBe(true);
    expect(rMultipleLabel(0.5, 1)).toBe("0.5R");
  });

  it("averages the middle pair for an even count; zeros without trades", () => {
    expect(rMultipleChart(fx, [1, 4, 2, 3].map((r) => fxTrade({ rMultiple: r }))).medianR).toBe(2.5);
    expect(rMultipleChart(fx, [])).toEqual({ buckets: [], avgR: 0, medianR: 0, bestR: 0, worstR: 0, hasTrades: false });
  });
});

describe("PerformanceSummary", () => {
  const trades = [
    fxTrade({ closeTime: Date.UTC(2026, 10, 2, 9), netProfit: "7" }), // after now: still "this week/month"
    fxTrade({ closeTime: Date.UTC(2026, 9, 19, 9), netProfit: "100" }), // Mon this week
    fxTrade({ closeTime: Date.UTC(2026, 9, 19, 15), netProfit: "-60" }),
    fxTrade({ closeTime: Date.UTC(2026, 9, 18, 0), netProfit: "0" }), // Sun 00:00, first instant of the week
    fxTrade({ closeTime: Date.UTC(2026, 9, 17, 23, 59), netProfit: "-40" }), // Sat: last week
    fxTrade({ closeTime: Date.UTC(2026, 8, 30, 9), netProfit: "20" }), // last month
    fxTrade({ closeTime: Date.UTC(2026, 8, 1, 0), netProfit: "5" }),
    fxTrade({ closeTime: Date.UTC(2026, 7, 31, 23, 59), netProfit: "-1" }), // August
  ];

  it("filters this week, this month and last month on the display calendar", () => {
    const m = performanceSummary(fx, trades);
    expect(m.thisWeek.start).toBe(Date.UTC(2026, 9, 18));
    expect(m.thisWeek.tradeCount).toBe(4);
    expect(m.thisWeek.pnl).toBe(47);
    expect(m.thisWeek.winRate).toBe(50);
    expect(m.thisWeek.daily).toEqual([
      { day: Date.UTC(2026, 9, 18), pnl: 0 },
      { day: Date.UTC(2026, 9, 19), pnl: 40 },
      { day: Date.UTC(2026, 10, 2), pnl: 7 },
    ]);
    expect(m.thisWeek.maxAbsDaily).toBe(40);
    expect(m.thisMonth.tradeCount).toBe(5);
    expect(m.thisMonth.pnl).toBe(7);
    expect([m.lastMonth.start, m.lastMonth.end]).toEqual([Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)]);
    expect(m.lastMonth.trades.map((t) => t.netProfit)).toEqual(["20", "5"]);
    const empty = performanceSummary(fx, []).thisWeek;
    expect([empty.winRate, empty.maxAbsDaily, empty.daily.length]).toEqual([0, 1, 0]);
  });

  it("follows the week start and zone of the brand calendar", () => {
    const monday = createEngineContext({ brand: "dojix", now: NOW, local: { weekStart: 2 } });
    expect(performanceSummary(monday, trades).thisWeek.tradeCount).toBe(3);
    // Greenwick: Monday-start weeks in New York, whatever the computer's calendar.
    const g = createEngineContext({ brand: "greenwick", now: NOW, local: { tz: "Asia/Tokyo", weekStart: 1 } });
    const m = performanceSummary(g, [stTrade({ closeTime: etWall(2026, 10, 18, 23, 0), netProfit: "9" }), stTrade({ closeTime: etWall(2026, 10, 19, 0, 30), netProfit: "3" })]);
    expect(m.thisWeek.start).toBe(etWall(2026, 10, 19, 0, 0));
    expect(m.thisWeek.pnl).toBe(3);
    expect(m.thisMonth.pnl).toBe(12);
  });

  it("sizes sparkline bars with a 2-point floor", () => {
    expect(sparklineBarHeight(20, 40)).toBe(12);
    expect(sparklineBarHeight(-1, 40)).toBe(2);
    expect(sparklineBarHeight(0, 0)).toBe(2);
  });
});

describe("StreakTimeline", () => {
  it("groups equal isWin runs in close order; a breakeven joins the losers", () => {
    const m = streakTimeline(fx, fxSeries(["10", "5", "0", "-3", "8"]).reverse());
    expect(m.segments).toEqual([
      { isWin: true, count: 2, startIndex: 0 },
      { isWin: false, count: 2, startIndex: 2 },
      { isWin: true, count: 1, startIndex: 4 },
    ]);
    expect(m.totalTrades).toBe(5);
    expect(streakTimeline(fx, []).segments).toEqual([]);
  });
});

describe("SessionHeatmap", () => {
  it("uses numerically sorted active hours, Mon–Fri rows and the date-range subtitle", () => {
    const trades = [
      fxTrade({ dayOfWeek: "Tue", hour: 10, netProfit: "40", closeTime: Date.UTC(2026, 2, 3, 10) }),
      fxTrade({ dayOfWeek: "Mon", hour: 9, netProfit: "-20", closeTime: Date.UTC(2026, 0, 5, 9) }),
      fxTrade({ dayOfWeek: "Tue", hour: 10, netProfit: "-10", closeTime: Date.UTC(2026, 1, 3, 10) }),
      fxTrade({ dayOfWeek: "Sat", hour: 3, netProfit: "500", closeTime: Date.UTC(2026, 1, 7, 3) }),
    ];
    const m = sessionHeatmap(fx, trades);
    expect(m.sortedActiveHours).toEqual([3, 9, 10]);
    expect(m.heatmapData).toHaveLength(15);
    expect(m.heatmapData.find((c) => c.id === "Tue-10")).toEqual({ id: "Tue-10", hour: 10, day: "Tue", profit: 30, tradeCount: 2 });
    expect(m.maxAbsProfit).toBe(30);
    expect(m.dateRangeLabel).toBe("Jan 5 – Mar 3, 2026 · 3 active hours · 4 trades");
    expect([m.firstClose, m.lastClose]).toEqual([Date.UTC(2026, 0, 5, 9), Date.UTC(2026, 2, 3, 10)]);
    const one = sessionHeatmap(fx, [fxTrade({ hour: 7, closeTime: Date.UTC(2026, 11, 31, 23) })]);
    expect(one.dateRangeLabel).toBe("Dec 31 – Dec 31, 2026 · 1 active hour · 1 trades");
  });

  it("formats the subtitle in the user's zone and locale (DateFormatter with Locale.current)", () => {
    const trades = [fxTrade({ hour: 9, closeTime: Date.UTC(2026, 2, 1, 20) }), fxTrade({ hour: 9, closeTime: Date.UTC(2026, 10, 2, 20) })];
    const tokyo = createEngineContext({ brand: "dojix", now: 0, local: { tz: "Asia/Tokyo" }, locale: "ja_JP" });
    expect(sessionHeatmap(tokyo, trades).dateRangeLabel).toBe("3月 2 – 11月 3, 2026 · 1 active hour · 2 trades");
    const london = createEngineContext({ brand: "dojix", now: 0, local: { tz: "Europe/London" }, locale: "en_GB" });
    expect(sessionHeatmap(london, trades).dateRangeLabel).toBe("Mar 1 – Nov 2, 2026 · 1 active hour · 2 trades");
  });

  it("Greenwick keys by the ET open weekday and formats dates in New York", () => {
    const t = stTrade({ openTime: etWall(2026, 1, 5, 21, 0), closeTime: etWall(2026, 1, 5, 22, 0), hour: 21, dayOfWeek: "x", netProfit: "4" });
    const m = sessionHeatmap(st, [t]);
    expect(m.heatmapData.find((c) => c.tradeCount > 0)?.id).toBe("Mon-21");
    expect(m.dateRangeLabel).toBe("Jan 5 – Jan 5, 2026 · 1 active hour · 1 trades");
  });

  it("colours only cells with a non-zero P&L", () => {
    expect(sessionHeatmapOpacity({ profit: 15, tradeCount: 1 }, 30)).toBeCloseTo(0.6, 12);
    expect(sessionHeatmapOpacity({ profit: -60, tradeCount: 1 }, 30)).toBe(1);
    expect(sessionHeatmapOpacity({ profit: 0, tradeCount: 2 }, 30)).toBeNull();
    expect(sessionHeatmapOpacity({ profit: 0, tradeCount: 0 }, 30)).toBeNull();
    const empty = sessionHeatmap(fx, []);
    expect([empty.dateRangeLabel, empty.maxAbsProfit, empty.firstClose]).toEqual(["", 1, null]);
  });
});

describe("SessionIntelligence", () => {
  const make = (session: DojixTrade["session"], profits: string[], r: number) => profits.map((p) => fxTrade({ session, netProfit: p, rMultiple: r }));

  it("recommends per session in enum order", () => {
    const trades = [
      ...make("LATE", ["-5", "5"], -1),
      ...make("NY", ["10", "-10"], 0.2),
      ...make("LONDON", ["10", "10", "10", "-5", "0"], 1),
      ...make("ASIAN", ["10", "-30", "-30", "-30", "-30"], -0.5),
      ...make("NY_OVERLAP", ["10", "20"], 0.1),
    ];
    const m = sessionIntelligence(fx, trades);
    expect(m.sessionData.map((s) => [s.id, s.displayName, s.recommendation])).toEqual([
      ["ASIAN", "Asian", "avoid"],
      ["LONDON", "London", "focus"],
      ["NY_OVERLAP", "NY Overlap", "neutral"],
      ["NY", "New York", "neutral"],
      ["LATE", "Late", "reduce"],
    ]);
    const london = m.sessionData[1];
    expect(london).toMatchObject({ profit: 25, tradeCount: 5, wins: 3, losses: 1, winRate: 60, avgR: 1, profitFactor: 6 });
    expect(m.sessionData[2]?.profitFactor).toBe(Infinity);
    expect(m.focus).toEqual(["London"]);
    expect(m.avoid).toEqual(["Asian"]);
  });

  it("follows the thresholds exactly", () => {
    expect(sessionRecommendation(0.5, 50, 5)).toBe("focus");
    expect(sessionRecommendation(0.5, 50, 4)).toBe("neutral");
    expect(sessionRecommendation(0, 40, 1)).toBe("neutral");
    expect(sessionRecommendation(-0.01, 90, 5)).toBe("avoid");
    expect(sessionRecommendation(-0.01, 90, 4)).toBe("reduce");
    expect(sessionRecommendation(0.2, 39.9, 9)).toBe("reduce");
  });

  it("uses the Greenwick market sessions", () => {
    const m = sessionIntelligence(st, [stTrade({ session: "AFTER_HOURS", netProfit: "0" }), stTrade({ session: "PRE_MARKET", netProfit: "-1" })]);
    expect(m.sessionData.map((s) => [s.displayName, s.profitFactor])).toEqual([
      ["Pre-Market", 0],
      ["After Hours", 0],
    ]);
  });
});

describe("SequenceAnalysis", () => {
  const series = (pattern: string, win = "50", loss = "-30") =>
    fxSeries([...pattern].map((c) => (c === "W" ? win : c === "B" ? "0" : loss))).reverse();

  it("needs 20 trades", () => {
    expect(sequenceAnalysis(fx, series("WL".repeat(9) + "W")).stats).toBeNull();
  });

  it("counts transitions with breakevens on the loss side (DojixTests ports)", () => {
    const s = sequenceAnalysis(fx, series("WWLWWWLWLW" + "WWLWWWLWLW")).stats;
    // Pattern repeated: after wins W W L W W W L W L W W W L …
    expect(s && [s.ww, s.wl, s.lw, s.ll]).toEqual([7, 6, 6, 0]);
    expect(s?.winAfterWin).toBeCloseTo((7 / 13) * 100, 12);
    expect(s?.lossAfterLoss).toBe(0);
    const losses = sequenceAnalysis(fx, series("L".repeat(20))).stats;
    expect(losses?.ll).toBe(19);
    expect(losses?.pattern).toBe("Tilt Risk");
    const breakevens = sequenceAnalysis(fx, series("B".repeat(20))).stats;
    expect(breakevens?.ll).toBe(19);
    expect(breakevens?.pattern).toBe("Random"); // LL 100 %, but 0 < 0 × .5 is false; no WW
  });

  it("detects mean reversion and momentum", () => {
    expect(sequenceAnalysis(fx, series("WL".repeat(10))).stats?.pattern).toBe("Mean Reverting");
    const momentum = fxSeries([...Array(10).fill("-1"), "1000", ...Array(9).fill("1")]).reverse();
    const s = sequenceAnalysis(fx, momentum).stats;
    expect(s?.pattern).toBe("Momentum");
    expect(s?.avgPnLAfterLoss).toBeCloseTo(99.1, 12);
    expect(s?.avgPnLAfterWin).toBe(1);
    expect(sequencePattern(50, 50, 50, 50, 1, 1)).toBe("Random");
    expect(SEQUENCE_INSIGHT.Random).toMatch(/independent/);
  });
});

/** Dojix trades on `days` distinct close days (10:00 UTC), cycling. */
function onDays(n: number, days: number, overrides: Partial<DojixTrade>, start = Date.UTC(2026, 0, 5)): DojixTrade[] {
  return Array.from({ length: n }, (_, i) => fxTrade({ ...overrides, closeTime: start + (i % days) * DAY + 10 * 3_600_000 }));
}

describe("WhatToCutAdvisor", () => {
  it("lists negative-expectancy conditions with ≥ 10 trades by monthly impact", () => {
    const trades = [
      ...onDays(20, 10, { hour: 9, symbol: "EURUSD", netProfit: "-10" }),
      ...onDays(20, 10, { hour: 14, symbol: "GBPUSD", netProfit: "30" }),
      ...onDays(9, 3, { hour: 3, symbol: "AUDUSD", netProfit: "-10" }), // under 10 trades: never listed
    ];
    const m = whatToCut(fx, trades);
    expect(m.tradingDays).toBe(10);
    expect(m.hasEnoughData).toBe(true);
    expect(m.negativeConditions.map((c) => [c.dimension, c.label, c.monthlyImpact])).toEqual([
      ["Hour", "9:00", -420],
      ["Pair", "EURUSD", -420],
    ]);
    expect(m.totalPotentialSavings).toBe(-840);
    expect(m.worstCondition?.label).toBe("9:00");
    expect(whatToCutCsvRows(m)).toEqual([
      ["Dimension", "Condition", "P&L", "Win Rate", "Trades", "Expectancy", "Profit Factor", "Monthly Impact"],
      ["Hour", "9:00", "-200.00", "0.0", "20", "-10.00", "0.00", "-420.00"],
      ["Pair", "EURUSD", "-200.00", "0.0", "20", "-10.00", "0.00", "-420.00"],
      [],
      ["Total Potential Savings (monthly)", "-840.00"],
    ]);
  });

  it("needs 30 trades; counts at least one trading day; Greenwick counts ET close days", () => {
    const m = whatToCut(fx, []);
    expect([m.tradingDays, m.hasEnoughData, m.worstCondition, m.totalPotentialSavings]).toEqual([1, false, null, 0]);
    // A Friday 18:50 ET close is 00:50 Saturday in Berlin, still the same trading day.
    const g = createEngineContext({ brand: "greenwick", now: NOW, local: { tz: "Europe/Berlin" } });
    const trades = [stTrade({ closeTime: etWall(2026, 10, 23, 10, 0) }), stTrade({ closeTime: etWall(2026, 10, 23, 18, 50) })];
    expect(whatToCut(g, trades).tradingDays).toBe(1);
  });
});

describe("KillZoneOptimizer", () => {
  const trades = (): Trade[] => [
    ...onDays(10, 5, { hour: 8, netProfit: "10" }),
    ...onDays(10, 5, { hour: 9, netProfit: "5" }),
    ...onDays(5, 5, { hour: 10, netProfit: "-100" }),
    ...onDays(12, 5, { hour: 14, netProfit: "-20" }),
    ...onDays(10, 5, { hour: 20, netProfit: "30" }),
    ...onDays(3, 3, { hour: 23, netProfit: "-50" }),
  ];

  it("merges qualifying adjacent hours into windows sorted by |P&L|", () => {
    const m = killZoneOptimizer(fx, trades());
    expect(m.isActionable).toBe(true);
    expect(m.tradingDays).toBe(5);
    expect(m.recommendWindows).toEqual([
      { startHour: 20, endHour: 20, pnl: 300, count: 10, winRate: 100, monthlyImpact: 1260, label: "20-21 UTC" },
      { startHour: 8, endHour: 9, pnl: 150, count: 20, winRate: 100, monthlyImpact: 630, label: "08-10 UTC" },
    ]);
    expect(m.avoidWindows).toEqual([{ startHour: 14, endHour: 14, pnl: -240, count: 12, winRate: 0, monthlyImpact: -1008, label: "14-15 UTC" }]);
    expect(m.topWindowMonthlyPnL).toBe(1890);
    expect(m.timeline[8]).toBe("positive");
    expect(m.timeline[10]).toBe("insufficient");
    expect(m.timeline[14]).toBe("negative");
    expect(m.hourlyStats[23]).toEqual({ hour: 23, pnl: -150, count: 3, winRate: 0 });
    expect(m.hourlyStats[0]).toEqual({ hour: 0, pnl: 0, count: 0, winRate: 0 });
    const csv = killZoneCsvRows(m);
    expect(csv[0]).toEqual(["Type", "Window", "P&L", "Win Rate", "Trades", "Monthly Impact"]);
    expect(csv[1]).toEqual(["Recommend", "20-21 UTC", "300.00", "100.0", "10", "1260.00"]);
    expect(csv[3]).toEqual(["Avoid", "14-15 UTC", "-240.00", "0.0", "12", "-1008.00"]);
    expect(csv[4]).toEqual([]);
    expect(csv[5]).toEqual(["Hour", "P&L", "Trades", "Win Rate"]);
    expect(csv[6]).toEqual(["8:00", "100.00", "10", "100.0"]);
    expect(csv).toHaveLength(6 + 6);
  });

  it("PARITY D-08: Dojix counts open days on the Mac, close days when fixed", () => {
    // Closes on 5 days, but every other trade opened the day before: 6 distinct open days.
    const ts = trades().map((t, i) => (i % 2 === 0 ? { ...t, openTime: t.closeTime - DAY } : t));
    const swift = killZoneOptimizer(fx, ts);
    const fixed = killZoneOptimizer(fxFixed, ts);
    expect([swift.tradingDaysBy, swift.tradingDays]).toEqual(["open", 6]);
    expect([fixed.tradingDaysBy, fixed.tradingDays]).toEqual(["close", 5]);
    expect(swift.recommendWindows[0]?.monthlyImpact).toBe(1050);
    expect(fixed.recommendWindows[0]?.monthlyImpact).toBe(1260);
  });

  it("Greenwick labels windows in ET and counts ET close days", () => {
    const g = Array.from({ length: 10 }, (_, i) => stTrade({ hour: 9, netProfit: "1", closeTime: etWall(2026, 10, 19 + (i % 2), 10, 0) }));
    const m = killZoneOptimizer(st, g);
    expect(m.recommendWindows[0]?.label).toBe("09-10 ET");
    expect([m.tradingDays, m.tradingDaysBy, m.isActionable]).toEqual([2, "close", false]);
    expect(killZoneOptimizer(fx, []).recommendWindows).toEqual([]);
  });
});

describe("PeriodComparison", () => {
  const ctx = createEngineContext({ brand: "dojix", now: Date.UTC(2026, 9, 27, 12), compat: "swift" });
  const trades = [
    fxTrade({ closeTime: Date.UTC(2026, 9, 26, 10), netProfit: "-50", rMultiple: -1 }),
    fxTrade({ closeTime: Date.UTC(2026, 9, 21, 10), netProfit: "100", rMultiple: 2 }),
    fxTrade({ closeTime: Date.UTC(2026, 9, 20, 12), netProfit: "1", rMultiple: 0 }), // exactly the cutoff: current
    fxTrade({ closeTime: Date.UTC(2026, 9, 15, 10), netProfit: "40", rMultiple: 1 }),
    fxTrade({ closeTime: Date.UTC(2026, 9, 13, 11, 59), netProfit: "1000", rMultiple: 9 }), // before the window
  ];

  it("compares the last 7 days with the 7 before", () => {
    const m = periodComparison(ctx, trades, "week");
    expect([m.currentCutoff, m.previousCutoff]).toEqual([Date.UTC(2026, 9, 20, 12), Date.UTC(2026, 9, 13, 12)]);
    expect(m.currentPeriodTrades).toHaveLength(3);
    expect(m.previousPeriodTrades).toHaveLength(1);
    const by = Object.fromEntries(m.comparisons.map((c) => [c.id, c]));
    expect(by.pnl).toMatchObject({ current: "$51.00", previous: "$40.00", change: 27.500000000000004, changeText: "27.5%", tone: "good", direction: "up" });
    expect(by.wr?.change).toBeCloseTo(-33.333333333333336, 12);
    expect(by.wr).toMatchObject({ current: "66.7%", previous: "100.0%", changeText: "33.3", tone: "bad", direction: "down" });
    // Profit factor: 2.02 against +∞ (no losses): (2.02 − ∞) / ∞ = NaN on the Mac too.
    expect(by.pf?.previous).toBe("99.99");
    expect(Number.isNaN(by.pf?.change)).toBe(true);
    expect(by.pf).toMatchObject({ changeText: "nan%", direction: "flat", tone: "neutral" });
    expect(by.avgr).toMatchObject({ current: "0.33R", previous: "1.00R", changeSuffix: "" });
    expect(by.trades).toMatchObject({ current: "3", previous: "1", change: 200 });
    // Max DD: 50 against 0 → +100 %, and a rising drawdown is bad.
    expect(by.dd).toMatchObject({ current: "$50.00", previous: "$0.00", change: 100, tone: "bad" });
    expect([m.hasPrevious, m.isEmpty]).toEqual([true, false]);
  });

  it("uses wall-clock days of the computer's calendar (DST) also in Greenwick", () => {
    const now = Date.UTC(2026, 9, 27, 12); // 13:00 in Berlin, two days after the switch to CET
    const berlin = createEngineContext({ brand: "greenwick", now, local: { tz: "Europe/Berlin" } });
    const m = periodComparison(berlin, [], "week");
    expect(m.currentCutoff).toBe(Date.UTC(2026, 9, 20, 11));
    expect([m.isEmpty, m.hasPrevious]).toEqual([true, false]);
    expect(periodComparison(berlin, []).period).toBe("month");
    expect(periodComparison(berlin, [], "quarter").previousCutoff).toBe(berlin.localCalendar.addDays(now, -180));
  });

  it("percentChange follows the Mac's zero rule", () => {
    expect(percentChange(5, 0)).toBe(100);
    expect(percentChange(-5, 0)).toBe(-100);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(-30, -20)).toBe(-50);
  });
});

describe("D-17 cross-check", () => {
  it("StreakTimeline groups a breakeven with losses where MetricsCalculator ignores it", () => {
    const asc = fxSeries(["10", "0"]);
    // MetricsCalculator: the breakeven changes nothing, the current streak reads 0 after it.
    expect(streaksOf(asc)).toEqual({ maxWinStreak: 1, maxLossStreak: 0, currentStreak: 0 });
    expect(streakTimeline(fx, asc).segments.at(-1)).toEqual({ isWin: false, count: 1, startIndex: 1 });
  });
});
