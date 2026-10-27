// Greenwick's exchange calendar: `Market` and `TradingCalendar`
// (Greenwick `Services/Analytics/TradingCalendar.swift`, `Extensions/Date+Market.swift`).
//
// Everything Greenwick buckets is in exchange time (America/New_York with the exchange's own
// daylight saving), independent of the computer's zone:
// - stored session, hour and weekday come from the **open** time in ET;
// - a trade's **trading day** is the ET date of its **close** (a Friday 18:50 ET close is a
//   Friday trade for a user anywhere);
// - weeks start on Monday with minimumDaysInFirstWeek 4; weekday names are POSIX.
// The analytics have no holiday calendar (holidays.ts is for the desktop session clock only).

import type { MarketSession } from "../model/enums";
import type { GreenwickTrade } from "../model/trade";
import { profitDouble } from "../model/accessors";
import { ZonedCalendar, type WeekdayName } from "./zoned-calendar";

/** An exchange: its zone and session boundaries in minutes after local midnight. */
export interface Market {
  name: string;
  timeZone: string;
  preMarketOpen: number;
  regularOpen: number;
  regularClose: number;
  afterHoursClose: number;
}

/** `Market.us` (TradingCalendar.swift:22-29): pre-market 04:00, regular 09:30–16:00, after-hours to 20:00. */
export const US_MARKET: Readonly<Market> = Object.freeze({
  name: "US",
  timeZone: "America/New_York",
  preMarketOpen: 4 * 60,
  regularOpen: 9 * 60 + 30,
  regularClose: 16 * 60,
  afterHoursClose: 20 * 60,
});

/** `Market.session(atMinute:)` (TradingCalendar.swift:36-41); weekends are the caller's job. */
export function sessionAtMinute(minute: number, market: Market = US_MARKET): MarketSession {
  if (minute >= market.preMarketOpen && minute < market.regularOpen) return "PRE_MARKET";
  if (minute >= market.regularOpen && minute < market.regularClose) return "REGULAR";
  if (minute >= market.regularClose && minute < market.afterHoursClose) return "AFTER_HOURS";
  return "EXTENDED";
}

/** `Market.nextBoundary(afterMinute:)` (TradingCalendar.swift:44-47); past 20:00 it is 24 h + 04:00. */
export function nextBoundaryAfterMinute(minute: number, market: Market = US_MARKET): number {
  const boundaries = [market.preMarketOpen, market.regularOpen, market.regularClose, market.afterHoursClose];
  return boundaries.find((b) => minute < b) ?? 24 * 60 + market.preMarketOpen;
}

/** `TradingCalendar.calendar`: Gregorian, America/New_York, Monday first, minimum 4 days. */
export const TRADING_CALENDAR = new ZonedCalendar({
  tz: US_MARKET.timeZone,
  weekStart: 2,
  minDaysInFirstWeek: 4,
});

/** The five trading weekdays, Monday first (`TradingCalendar.tradingWeekdays`, chart order). */
export const TRADING_WEEKDAYS: readonly WeekdayName[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** `TradingCalendar.session(_:)`: ET session of an instant; Saturday and Sunday are Extended. */
export function etSession(t: number): MarketSession {
  return TRADING_CALENDAR.isWeekend(t) ? "EXTENDED" : sessionAtMinute(TRADING_CALENDAR.minuteOfDay(t));
}

/** `TradingCalendar.sessionIgnoringWeekend(_:)` (the sidebar's live clock). */
export function etSessionIgnoringWeekend(t: number): MarketSession {
  return sessionAtMinute(TRADING_CALENDAR.minuteOfDay(t));
}

/**
 * `TradingCalendar.timeToNextSession(from:)` in seconds: whole minutes on the ET wall clock to
 * the next boundary. Like the Mac it ignores weekends, seconds and DST changes overnight (a
 * Friday 20:30 ET reports 7 h 30 min, to "Saturday 04:00"). The desktop clock uses
 * `usSessionClock` (holidays.ts) instead; this one is kept for parity.
 */
export function etTimeToNextSession(t: number): number {
  const minute = TRADING_CALENDAR.minuteOfDay(t);
  return (nextBoundaryAfterMinute(minute) - minute) * 60;
}

/** ET hour of the instant (`Date.etHour`). */
export function etHour(t: number): number {
  return TRADING_CALENDAR.hour(t);
}

/** ET minute of the hour (`Date.etMinute`). */
export function etMinute(t: number): number {
  return TRADING_CALENDAR.minute(t);
}

/** ET weekday name ("Mon"…), what Greenwick stores as `dayOfWeek` (`Date.shortDayName`). */
export function etWeekdayName(t: number): WeekdayName {
  return TRADING_CALENDAR.weekdayName(t);
}

// --- trades ----------------------------------------------------------------------------------

/** `Trade.tradingDay`: New York midnight of the close's ET date (epoch ms). */
export function tradingDay(trade: Pick<GreenwickTrade, "closeTime">): number {
  return TRADING_CALENDAR.startOfDay(trade.closeTime);
}

/** `Trade.tradingWeekday`: weekday of the trading day (the close, ET). */
export function tradingWeekday(trade: Pick<GreenwickTrade, "closeTime">): WeekdayName {
  return TRADING_CALENDAR.weekdayName(trade.closeTime);
}

/** `Trade.entryWeekday`: weekday of the open in ET (pairs with `hour` in heatmaps). */
export function entryWeekday(trade: Pick<GreenwickTrade, "openTime">): WeekdayName {
  return TRADING_CALENDAR.weekdayName(trade.openTime);
}

/**
 * `TradingCalendar.dailyPnL`: net P&L per trading day keyed by the day's start (epoch ms),
 * summed in input order. The Map keeps first-appearance order (the Mac's dictionary is unordered).
 */
export function dailyPnL(trades: readonly GreenwickTrade[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const t of trades) {
    const day = tradingDay(t);
    result.set(day, (result.get(day) ?? 0) + profitDouble(t));
  }
  return result;
}

/** `TradingCalendar.tradingDayCount`: distinct trading days with at least one close. */
export function etTradingDayCount(trades: readonly Pick<GreenwickTrade, "closeTime">[]): number {
  return new Set(trades.map(tradingDay)).size;
}

/** `TradingCalendar.pnl(onTradingDayOf:)`: P&L of trades closed on `now`'s trading day. */
export function pnlOnTradingDayOf(now: number, trades: readonly GreenwickTrade[]): number {
  const today = TRADING_CALENDAR.startOfDay(now);
  let total = 0;
  for (const t of trades) if (tradingDay(t) === today) total += profitDouble(t);
  return total;
}

/** `TradingCalendar.groupedByWeekday`: trades by the weekday of their trading day (first-appearance order). */
export function groupedByTradingWeekday<T extends Pick<GreenwickTrade, "closeTime">>(
  trades: readonly T[],
): Map<WeekdayName, T[]> {
  const groups = new Map<WeekdayName, T[]>();
  for (const t of trades) {
    const k = tradingWeekday(t);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  return groups;
}
