// Timing tab: HourlyPnLChart, DurationAnalysis, DayOfWeekChart, TradeTimeHeatmap,
// TradeCalendar, WeeklyHeatmap. Hand-checked cases plus the Greenwick TradingDayTests ports.
import { describe, expect, it } from "vitest";
import { createEngineContext } from "../engine/context";
import { etWall, fxTrade, stTrade } from "../test-support/trades";
import { dayOfWeekChart } from "./day-of-week";
import { DURATION_RANGES, durationAnalysis } from "./duration-analysis";
import { hourlyPnL } from "./hourly-pnl";
import { shiftMonth, tradeCalendar, tradeCalendarGrid } from "./trade-calendar";
import { TRADE_TIME_DISPLAY_HOURS, tradeTimeHeatmap, tradeTimeIntensity, tradeTimeOpacity } from "./trade-time-heatmap";
import { weeklyCellOpacity, weeklyHeatmap, weeklyStreak } from "./weekly-heatmap";

const NOW = Date.UTC(2026, 9, 21, 12, 0);
const fx = createEngineContext({ brand: "dojix", now: NOW, compat: "swift" });
const st = createEngineContext({ brand: "greenwick", now: NOW, compat: "swift" });

describe("HourlyPnLChart", () => {
  it("sums per stored hour, drops empty hours and picks the first maximum", () => {
    const trades = [
      fxTrade({ hour: 22, netProfit: "70" }),
      fxTrade({ hour: 9, netProfit: "100" }),
      fxTrade({ hour: 14, netProfit: "70" }),
      fxTrade({ hour: 9, netProfit: "-30" }),
      fxTrade({ hour: 24, netProfit: "500" }),
      fxTrade({ hour: -1, netProfit: "500" }),
    ];
    const m = hourlyPnL(fx, trades);
    expect(m.hourlyData).toEqual([
      { hour: 9, pnl: 70, count: 2 },
      { hour: 14, pnl: 70, count: 1 },
      { hour: 22, pnl: 70, count: 1 },
    ]);
    // Three hours tie at 70: Swift's max(by:) returns the first one.
    expect(m.best).toEqual({ hour: 9, pnl: 70, count: 2 });
    expect(m.sampleSize).toBe(6);
    expect(m.zoneLabel).toBe("UTC");
  });

  it("is empty without trades and labels Greenwick hours ET", () => {
    expect(hourlyPnL(st, [])).toEqual({ hourlyData: [], best: null, sampleSize: 0, zoneLabel: "ET" });
  });
});

describe("DurationAnalysis", () => {
  it("assigns the closed integer ranges (DojixTests testDurationBucketAssignment)", () => {
    const at = (d: number) => DURATION_RANGES.findIndex((r) => r.lower <= d && d <= r.upper);
    expect([3, 10, 25, 45, 90, 180].map(at)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(at(6)).toBe(1);
    expect([5, 6, 15, 16, 30, 31, 60, 61, 120, 121, 999_999].map(at)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect([-1, 1_000_000].map(at)).toEqual([-1, -1]);
  });

  it("computes profit, WR and average R per bucket", () => {
    const trades = [
      fxTrade({ durationMin: 3, netProfit: "10", rMultiple: 1 }),
      fxTrade({ durationMin: 5, netProfit: "-4", rMultiple: -0.5 }),
      fxTrade({ durationMin: 0, netProfit: "0", rMultiple: 0 }),
      fxTrade({ durationMin: 200, netProfit: "50", rMultiple: 2 }),
      fxTrade({ durationMin: -5, netProfit: "1000", rMultiple: 9 }),
    ];
    const m = durationAnalysis(fx, trades);
    expect(m.buckets).toEqual([
      { id: "0-5m", label: "0-5m", profit: 6, tradeCount: 3, winRate: (1 / 3) * 100, avgR: 0.5 / 3 },
      { id: "2h+", label: "2h+", profit: 50, tradeCount: 1, winRate: 100, avgR: 2 },
    ]);
    // The highest average R is the 2h+ bucket, which has fewer than 3 trades: no sweet spot,
    // even though another bucket has 3 (the Mac picks first, then checks the count).
    expect(m.sweetSpot).toBeNull();
    expect(m.sampleSize).toBe(5);
  });

  it("shows the sweet spot when the best bucket has ≥ 3 trades (first of ties)", () => {
    const trades = [5, 5, 5, 40, 40, 40].map((d) => fxTrade({ durationMin: d, netProfit: "1", rMultiple: 1 }));
    expect(durationAnalysis(fx, trades).sweetSpot?.label).toBe("0-5m");
    expect(durationAnalysis(fx, []).buckets).toEqual([]);
  });
});

describe("DayOfWeekChart", () => {
  it("Dojix groups by the stored label, Monday to Friday only", () => {
    const trades = [
      fxTrade({ dayOfWeek: "Fri", netProfit: "30" }),
      fxTrade({ dayOfWeek: "Mon", netProfit: "30" }),
      fxTrade({ dayOfWeek: "Mon", netProfit: "-10" }),
      fxTrade({ dayOfWeek: "Tue", netProfit: "20" }),
      fxTrade({ dayOfWeek: "Sat", netProfit: "999" }),
      fxTrade({ dayOfWeek: "Fr.", netProfit: "999" }),
    ];
    const m = dayOfWeekChart(fx, trades);
    expect(m.data.map((d) => [d.day, d.profit, d.tradeCount, d.winRate])).toEqual([
      ["Mon", 20, 2, 50],
      ["Tue", 20, 1, 100],
      ["Fri", 30, 1, 100],
    ]);
    expect(m.best?.day).toBe("Fri");
    // Mon and Tue tie at 20: min(by:) keeps the first.
    expect(m.worst?.day).toBe("Mon");
    expect(dayOfWeekChart(fx, [])).toEqual({ data: [], best: null, worst: null, sampleSize: 0 });
  });

  it("Greenwick uses the ET trading day of the close, whatever the stored label (TradingDayTests)", () => {
    const afterHours = stTrade({ openTime: etWall(2026, 10, 23, 18, 20), closeTime: etWall(2026, 10, 23, 18, 50), netProfit: "125", dayOfWeek: "Fr." });
    const swing = stTrade({ openTime: etWall(2026, 10, 22, 15, 30), closeTime: etWall(2026, 10, 23, 18, 50), netProfit: "80", dayOfWeek: "Thu" });
    for (const tz of ["Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"]) {
      const ctx = createEngineContext({ brand: "greenwick", now: NOW, local: { tz } });
      const m = dayOfWeekChart(ctx, [afterHours, swing]);
      expect(m.data.map((d) => d.day), tz).toEqual(["Fri"]);
      expect(m.data[0]?.profit).toBe(205);
    }
  });
});

describe("TradeTimeHeatmap", () => {
  it("fills a 5 × 24 grid keyed by day and hour", () => {
    const trades = [
      fxTrade({ dayOfWeek: "Mon", hour: 9, netProfit: "40" }),
      fxTrade({ dayOfWeek: "Mon", hour: 9, netProfit: "-10" }),
      fxTrade({ dayOfWeek: "Wed", hour: 3, netProfit: "-60" }),
      fxTrade({ dayOfWeek: "Sun", hour: 9, netProfit: "500" }),
    ];
    const m = tradeTimeHeatmap(fx, trades);
    expect(m.cells).toHaveLength(120);
    expect(m.cells[0]).toEqual({ id: "Mon-0", day: "Mon", hour: 0, pnl: 0, count: 0 });
    expect(m.cells.find((c) => c.id === "Mon-9")).toEqual({ id: "Mon-9", day: "Mon", hour: 9, pnl: 30, count: 2 });
    expect(m.cells.find((c) => c.id === "Wed-3")?.pnl).toBe(-60);
    // The weekend trade is in no cell, so it doesn't set the scale.
    expect(m.maxAbsPnL).toBe(60);
    expect(m.displayHours).toEqual([...TRADE_TIME_DISPLAY_HOURS]);
    expect(m.displayHours[0]).toBe(6);
    expect(m.displayHours.at(-1)).toBe(21);
  });

  it("Greenwick files trades under the ET weekday of the open", () => {
    // Opened Monday 10:00 ET, stored label in another language.
    const t = stTrade({ openTime: etWall(2026, 10, 19, 10, 0), closeTime: etWall(2026, 10, 20, 10, 0), hour: 10, dayOfWeek: "Mo.", netProfit: "5" });
    expect(tradeTimeHeatmap(st, [t]).cells.find((c) => c.count > 0)?.id).toBe("Mon-10");
  });

  it("scales the cell opacity like the Mac", () => {
    expect(tradeTimeIntensity(-30, 60)).toBe(0.5);
    expect(tradeTimeIntensity(90, 60)).toBe(1);
    expect(tradeTimeIntensity(5, 0)).toBe(0);
    expect(tradeTimeOpacity({ pnl: -30, count: 1 }, 60)).toBeCloseTo(0.575, 12);
    expect(tradeTimeOpacity({ pnl: 0, count: 0 }, 60)).toBeNull();
    expect(tradeTimeHeatmap(fx, []).maxAbsPnL).toBe(0);
  });
});

describe("TradeCalendar", () => {
  it("sums daily P&L, the month total and trading days for the month of now", () => {
    const trades = [
      fxTrade({ closeTime: Date.UTC(2026, 9, 5, 10), netProfit: "100" }),
      fxTrade({ closeTime: Date.UTC(2026, 9, 5, 15), netProfit: "-30" }),
      fxTrade({ closeTime: Date.UTC(2026, 9, 21, 9), netProfit: "0" }),
      fxTrade({ closeTime: Date.UTC(2026, 8, 30, 9), netProfit: "50" }),
    ];
    const m = tradeCalendar(fx, trades);
    expect([m.year, m.monthNumber, m.days.length]).toEqual([2026, 10, 31]);
    expect(m.days[4]).toEqual({ date: Date.UTC(2026, 9, 5), dayOfMonth: 5, pnl: 70, isToday: false });
    expect(m.days[20]).toMatchObject({ pnl: 0, isToday: true });
    expect(m.days[0]?.pnl).toBeNull();
    expect(m.monthTotal).toBe(70);
    expect(m.tradingDays).toBe(2);
    expect(m.dailyPnL.get(Date.UTC(2026, 8, 30))).toBe(50);
    // 1 Oct 2026 is a Thursday: 4 blanks on a Sunday-first grid.
    expect(m.leadingBlankCount).toBe(4);
    expect(m.weekdayHeaderNames).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

    const september = tradeCalendar(fx, trades, shiftMonth(fx, NOW, -1));
    expect([september.monthNumber, september.monthTotal, september.tradingDays]).toEqual([9, 50, 1]);
  });

  it("Dojix keeps Sunday-first headers with a Monday-first offset (Mac trap); Greenwick rotates", () => {
    const fxMon = createEngineContext({ brand: "dojix", now: NOW, local: { weekStart: 2 } });
    const a = tradeCalendar(fxMon, []);
    expect(a.firstWeekday).toBe(2);
    expect(a.leadingBlankCount).toBe(3);
    expect(a.weekdayHeaders).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const stMon = createEngineContext({ brand: "greenwick", now: NOW, local: { weekStart: 2, tz: "Asia/Tokyo" } });
    const b = tradeCalendar(stMon, []);
    expect(b.leadingBlankCount).toBe(3);
    expect(b.weekdayHeaderNames).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    // The column above the 23rd is Friday (TradingDayTests calendarCell).
    expect(b.weekdayHeaderNames[(b.leadingBlankCount + 22) % 7]).toBe("Fri");
  });

  it("Greenwick puts a Friday after-hours close on Friday in every zone (TradingDayTests)", () => {
    const trades = [
      stTrade({ openTime: etWall(2026, 10, 23, 10, 0), closeTime: etWall(2026, 10, 23, 10, 30), netProfit: "50" }),
      stTrade({ openTime: etWall(2026, 10, 23, 18, 20), closeTime: etWall(2026, 10, 23, 18, 50), netProfit: "125" }),
    ];
    for (const tz of ["Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"]) {
      for (const weekStart of [1, 2]) {
        const ctx = createEngineContext({ brand: "greenwick", now: NOW, local: { tz, weekStart } });
        const m = tradeCalendar(ctx, trades, trades[0]?.closeTime);
        expect(m.days[22]?.pnl, `${tz} ${weekStart}`).toBe(175);
        expect(m.days[23]?.pnl).toBeNull();
        expect(m.weekdayHeaderNames[(m.leadingBlankCount + 22) % 7]).toBe("Fri");
      }
    }
  });

  it("Greenwick grid days are New York midnights across DST (TradingDayTests)", () => {
    const ctx = createEngineContext({ brand: "greenwick", now: NOW, local: { tz: "Europe/Berlin" } });
    const march = tradeCalendar(ctx, [], etWall(2026, 3, 15, 12, 0)).days;
    const november = tradeCalendar(ctx, [], etWall(2026, 11, 15, 12, 0)).days;
    expect(march).toHaveLength(31);
    expect(november).toHaveLength(30);
    expect(march[0]?.date).toBe(etWall(2026, 3, 1, 0, 0));
    expect((march[8]?.date as number) - (march[7]?.date as number)).toBe(23 * 3_600_000);
    expect((november[1]?.date as number) - (november[0]?.date as number)).toBe(25 * 3_600_000);
    expect(tradeCalendarGrid(ctx).spec).toEqual({ tz: "America/New_York", weekStart: 1, minDaysInFirstWeek: 4 });
    // "Today" is the New York date of now: 2026-10-21 12:00 UTC is 08:00 in New York.
    expect(tradeCalendar(ctx, []).days.findIndex((d) => d.isToday)).toBe(20);
  });
});

describe("WeeklyHeatmap", () => {
  it("weekly streak: newest first, flat weeks skipped, a sign change stops", () => {
    const w = (...p: number[]) => p.map((profit) => ({ profit }));
    expect(weeklyStreak(w(-5, 3, 0, 4, 2))).toBe(3);
    expect(weeklyStreak(w(5, -3, 0, -4, -2))).toBe(-3);
    expect(weeklyStreak(w(0, 0))).toBe(0);
    expect(weeklyStreak([])).toBe(0);
  });

  it("Dojix keys weeks by (yearForWeekOfYear, weekOfYear) of the close", () => {
    const trades = [
      fxTrade({ closeTime: Date.UTC(2026, 0, 13, 10), netProfit: "-20" }), // Tue, week of Sun 11 Jan
      fxTrade({ closeTime: Date.UTC(2026, 0, 11, 10), netProfit: "50" }), // Sun 11 Jan
      fxTrade({ closeTime: Date.UTC(2026, 0, 3, 10), netProfit: "10" }), // Sat 3 Jan, week of Sun 28 Dec
      fxTrade({ closeTime: Date.UTC(2025, 11, 28, 10), netProfit: "-40" }),
    ];
    const m = weeklyHeatmap(fx, trades);
    expect(m.weeklyData).toEqual([
      { id: "2026-W1", weekStart: Date.UTC(2025, 11, 28), profit: -30, tradeCount: 2, winRate: 50 },
      { id: "2026-W3", weekStart: Date.UTC(2026, 0, 11), profit: 30, tradeCount: 2, winRate: 50 },
    ]);
    expect([m.profitableWeeks, m.totalWeeks, m.avgWeekly, m.currentStreak, m.maxAbsProfit, m.columns]).toEqual([1, 2, 0, 1, 30, 2]);
    const monday = createEngineContext({ brand: "dojix", now: NOW, local: { weekStart: 2, minDaysInFirstWeek: 4 } });
    expect(weeklyHeatmap(monday, trades).weeklyData.map((w) => w.id)).toEqual(["2025-W52", "2026-W1", "2026-W2", "2026-W3"]);
  });

  it("Greenwick uses Monday-start ET weeks keyed by the week's day key; shows the last 16", () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      stTrade({ closeTime: etWall(2026, 1, 5, 18, 50) + i * 7 * 86_400_000, netProfit: i % 2 === 0 ? "10" : "-5" }),
    );
    // Sunday 18:50 ET closes would start a new week; these are Mondays, 18:50 ET.
    const m = weeklyHeatmap(st, trades);
    expect(m.totalWeeks).toBe(20);
    expect(m.weeklyData[0]?.id).toBe("2026-01-05");
    expect(m.weeklyData[0]?.weekStart).toBe(etWall(2026, 1, 5, 0, 0));
    expect(m.displayData).toHaveLength(16);
    expect(m.displayData[0]?.id).toBe(m.weeklyData[4]?.id);
    expect(m.columns).toBe(4);
    expect(m.avgWeekly).toBe(2.5);
    expect(m.currentStreak).toBe(-1);
  });

  it("is empty without trades; the cell opacity follows the Mac", () => {
    const m = weeklyHeatmap(fx, []);
    expect([m.totalWeeks, m.avgWeekly, m.maxAbsProfit, m.columns]).toEqual([0, 0, 1, 0]);
    expect(weeklyCellOpacity(15, 30)).toBeCloseTo(0.25, 12);
    expect(weeklyCellOpacity(-30, 30)).toBeCloseTo(0.4, 12);
    expect(weeklyCellOpacity(0, 30)).toBeNull();
    expect(weeklyCellOpacity(5, 0)).toBe(0.1);
  });
});
