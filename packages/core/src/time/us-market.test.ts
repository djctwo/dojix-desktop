// Ports Greenwick GreenwickTests/TradingDayTests.swift. The engine never reads the process time
// zone (all fields come from Intl with an explicit zone), so the Mac's "in each zone" loop is
// covered by construction; CI also runs on runners in UTC.

import { describe, expect, it } from "vitest";
import { profitDouble } from "../model/accessors";
import { MARKET_SESSION_INFO, MARKET_SESSIONS } from "../model/enums";
import { edgeByDay } from "../metrics/edges";
import { etWall, stTrade } from "../test-support/trades";
import { dateRangeCutoff, DISTANT_PAST } from "./date-ranges";
import {
  dailyPnL,
  entryWeekday,
  etHour,
  etMinute,
  etSession,
  etSessionIgnoringWeekend,
  etTimeToNextSession,
  etTradingDayCount,
  etWeekdayName,
  groupedByTradingWeekday,
  nextBoundaryAfterMinute,
  pnlOnTradingDayOf,
  sessionAtMinute,
  TRADING_CALENDAR,
  TRADING_WEEKDAYS,
  tradingDay,
  tradingWeekday,
  US_MARKET,
} from "./us-market";

const trade = (open: number, close: number, profit: string, dayOfWeek?: string) =>
  stTrade({
    openTime: open,
    closeTime: close,
    netProfit: profit,
    session: etSession(open),
    dayOfWeek: dayOfWeek ?? etWeekdayName(open),
    hour: etHour(open),
  });

describe("sessions (TradingDayTests.swift:223-247)", () => {
  it("are New York time at every boundary", () => {
    const cases: [number, number, string][] = [
      [3, 59, "EXTENDED"],
      [4, 0, "PRE_MARKET"],
      [9, 29, "PRE_MARKET"],
      [9, 30, "REGULAR"],
      [15, 59, "REGULAR"],
      [16, 0, "AFTER_HOURS"],
      [19, 59, "AFTER_HOURS"],
      [20, 0, "EXTENDED"],
    ];
    for (const [h, m, s] of cases) expect(etSession(etWall(2026, 10, 23, h, m))).toBe(s);
    expect(etSession(etWall(2026, 10, 24, 11, 0))).toBe("EXTENDED"); // Saturday
    expect(etSessionIgnoringWeekend(etWall(2026, 10, 24, 11, 0))).toBe("REGULAR");
  });

  it("count down like the Mac (weekends ignored)", () => {
    expect(etTimeToNextSession(etWall(2026, 10, 23, 9, 0))).toBe(30 * 60);
    expect(etTimeToNextSession(etWall(2026, 10, 23, 20, 30))).toBe((7 * 60 + 30) * 60);
    expect(nextBoundaryAfterMinute(0)).toBe(240);
    expect(nextBoundaryAfterMinute(1200)).toBe(24 * 60 + 240);
    expect(sessionAtMinute(-5)).toBe("EXTENDED");
  });

  it("keeps the Mac's session hour table", () => {
    expect(MARKET_SESSIONS.map((s) => MARKET_SESSION_INFO[s].startHourET)).toEqual([4, 9, 16, 4]);
    expect(MARKET_SESSIONS.map((s) => MARKET_SESSION_INFO[s].endHourET)).toEqual([9, 16, 20, 20]);
    expect(US_MARKET.regularOpen).toBe(570);
    expect(TRADING_WEEKDAYS).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  });

  it("stores the English weekday and ET hour of the entry", () => {
    const t = trade(etWall(2026, 10, 23, 18, 20), etWall(2026, 10, 23, 18, 50), "125");
    expect(t.dayOfWeek).toBe("Fri");
    expect(t.hour).toBe(18);
    expect(t.session).toBe("AFTER_HOURS");
    expect(tradingWeekday(t)).toBe("Fri");
    expect(entryWeekday(t)).toBe("Fri");
    expect(etMinute(t.openTime)).toBe(20);
  });
});

describe("trading day = ET date of the close", () => {
  it("a Friday 18:50 ET close is a Friday trade (TradingDayTests.swift:105-118)", () => {
    const t = trade(etWall(2026, 10, 23, 18, 20), etWall(2026, 10, 23, 18, 50), "125");
    expect(TRADING_CALENDAR.dayKey(tradingDay(t))).toBe("2026-10-23");
    expect(edgeByDay([t]).map((e) => e.label)).toEqual(["Fri"]);
  });

  it("ignores a localised stored weekday label (TradingDayTests.swift:122-129)", () => {
    const t = trade(etWall(2026, 10, 23, 18, 20), etWall(2026, 10, 23, 18, 50), "125", "Fr.");
    expect(edgeByDay([t]).map((e) => e.label)).toEqual(["Fri"]);
    expect([...groupedByTradingWeekday([t]).keys()]).toEqual(["Fri"]);
  });

  it("a swing trade counts on its close day (TradingDayTests.swift:133-140)", () => {
    const swing = trade(etWall(2026, 10, 22, 15, 30), etWall(2026, 10, 23, 18, 50), "80");
    expect(tradingWeekday(swing)).toBe("Fri");
    expect(entryWeekday(swing)).toBe("Thu");
  });

  it("trading-day counts and today's P&L use the New York day (TradingDayTests.swift:153-164)", () => {
    const morning = trade(etWall(2026, 10, 23, 9, 45), etWall(2026, 10, 23, 10, 0), "50");
    const evening = trade(etWall(2026, 10, 23, 18, 20), etWall(2026, 10, 23, 18, 50), "-200");
    expect(etTradingDayCount([morning, evening])).toBe(1);
    expect(pnlOnTradingDayOf(etWall(2026, 10, 23, 19, 30), [morning, evening])).toBe(-150);
    expect(pnlOnTradingDayOf(etWall(2026, 10, 24, 10, 0), [morning, evening])).toBe(0);
    const daily = dailyPnL([morning, evening]);
    expect([...daily.values()]).toEqual([-150]);
    expect([...daily.keys()]).toEqual([etWall(2026, 10, 23, 0, 0)]);
  });

  it("a month-end after-hours trade stays in its month (TradingDayTests.swift:166-172)", () => {
    const t = trade(etWall(2026, 7, 31, 18, 20), etWall(2026, 7, 31, 18, 50), "125");
    expect(TRADING_CALENDAR.monthKey(t.closeTime)).toBe("2026-07");
  });

  it("follows daylight saving changes (TradingDayTests.swift:186-205)", () => {
    const cases: [number, number][] = [
      [etWall(2026, 3, 13, 19, 30), 13],
      [etWall(2026, 10, 30, 19, 30), 30],
      [etWall(2026, 11, 6, 18, 50), 6],
      [etWall(2026, 3, 10, 1, 30), 10],
    ];
    for (const [close, day] of cases) {
      const t = trade(close - 600_000, close, "42");
      expect(TRADING_CALENDAR.fields(tradingDay(t)).day).toBe(day);
      expect(profitDouble(t)).toBe(42);
    }
  });
});

describe("date filters", () => {
  it("start at New York midnight for Greenwick (TradingDayTests.swift:174-182)", () => {
    const fridayEvening = etWall(2026, 10, 23, 19, 30);
    expect(dateRangeCutoff("today", fridayEvening, TRADING_CALENDAR)).toBe(etWall(2026, 10, 23, 0, 0));
    expect(dateRangeCutoff("thisWeek", fridayEvening, TRADING_CALENDAR)).toBe(etWall(2026, 10, 19, 0, 0));
    expect(dateRangeCutoff("thisMonth", etWall(2026, 7, 31, 18, 30), TRADING_CALENDAR)).toBe(etWall(2026, 7, 1, 0, 0));
    expect(dateRangeCutoff("last30", fridayEvening, TRADING_CALENDAR)).toBe(etWall(2026, 9, 23, 19, 30));
    expect(dateRangeCutoff("last90", fridayEvening, TRADING_CALENDAR)).toBe(etWall(2026, 7, 25, 19, 30));
    expect(dateRangeCutoff("all", fridayEvening, TRADING_CALENDAR)).toBe(DISTANT_PAST);
  });
});
