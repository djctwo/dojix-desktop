// TradeCalendar (Timing tab, both brands). SPEC Appendix A "TradeCalendar".
//
// Dojix `Components/TradeCalendar.swift:9-31,84-85,106-109`: everything on `Calendar.current`
// (the desktop's display calendar, `ctx.calendar`).
// Greenwick `Components/TradeCalendar.swift:12-18,137-189`: days are ET trading days
// (`TradingCalendar.dailyPnL`); the grid is the trading calendar with only the **first weekday**
// taken from the computer (`gridCalendar(firstWeekday: Calendar.current.firstWeekday)`), and
// the column headers are rotated to start there. "Today" is the New York date of now.
//
// - daily P&L keyed by the start of the close's day, summed in input order;
// - the month shown starts at `ctx.now` (the Mac's `@State selectedMonth = Date()`); the
//   arrows move it by `calendar.date(byAdding: .month, value: ±1, to:)` (`shiftMonth`);
// - month total and trading days walk the month's days in order;
// - leading blanks = (weekday(1st) − firstWeekday + 7) % 7.
//
// Parity trap (kept): Dojix lists `shortWeekdaySymbols` (always Sunday first) as headers while
// the leading blanks follow `firstWeekday`, so with a Monday-first locale the headers sit one
// column off. `weekdayHeaders` reproduces that; Greenwick rotates them.

import type { EngineContext } from "../engine/context";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { TRADING_CALENDAR } from "../time/us-market";
import { POSIX_WEEKDAY_NAMES, ZonedCalendar } from "../time/zoned-calendar";

export interface TradeCalendarDay {
  /** 00:00 of the day in the grid calendar (`calendar.date(from: y, m, d)`), epoch ms. */
  date: number;
  dayOfMonth: number;
  /** The day's P&L, null when nothing closed that day. */
  pnl: number | null;
  isToday: boolean;
}

export interface TradeCalendarModel {
  /** Any instant in the month shown (the Mac's `selectedMonth`). */
  month: number;
  year: number;
  /** 1 … 12 */
  monthNumber: number;
  days: TradeCalendarDay[];
  /** Empty cells before the 1st. */
  leadingBlankCount: number;
  /** The grid's first weekday (1 = Sunday … 7 = Saturday). */
  firstWeekday: number;
  /** Header columns left to right as weekday numbers (1 = Sunday); see the parity note above. */
  weekdayHeaders: number[];
  /** POSIX short names of `weekdayHeaders` ("Sun"…); the UI localises them. */
  weekdayHeaderNames: string[];
  monthTotal: number;
  /** Days of the month with at least one close. */
  tradingDays: number;
  /** Daily P&L for every day with trades (any month), keyed by the day's start. */
  dailyPnL: Map<number, number>;
}

/** The calendar the month grid uses (Greenwick: `TradeCalendar.gridCalendar()`). */
export function tradeCalendarGrid(ctx: EngineContext): ZonedCalendar {
  if (ctx.brand === "dojix") return ctx.calendar;
  return new ZonedCalendar({ ...TRADING_CALENDAR.spec, weekStart: ctx.localCalendar.weekStart });
}

/** Net P&L per day of the close, keyed by the day's start (input order sums). */
export function tradeCalendarDailyPnL(ctx: EngineContext, trades: readonly Trade[]): Map<number, number> {
  const calendar = ctx.calendar;
  const result = new Map<number, number>();
  for (const t of trades) {
    const day = calendar.startOfDay(t.closeTime);
    result.set(day, (result.get(day) ?? 0) + profitDouble(t));
  }
  return result;
}

/** The previous / next month button (TradeCalendar.swift:42,54). */
export function shiftMonth(ctx: EngineContext, month: number, delta: number): number {
  return tradeCalendarGrid(ctx).addMonths(month, delta);
}

export function tradeCalendar(ctx: EngineContext, trades: readonly Trade[], month: number = ctx.now): TradeCalendarModel {
  const grid = tradeCalendarGrid(ctx);
  const dailyPnL = tradeCalendarDailyPnL(ctx, trades);
  const { year, month: monthNumber } = grid.fields(month);
  const count = grid.daysInMonthOf(month);
  const days: TradeCalendarDay[] = [];
  let monthTotal = 0;
  let tradingDays = 0;
  for (let d = 1; d <= count; d++) {
    const date = grid.instantFromWall(year, monthNumber, d);
    // The month total and day count look the date up directly (:84-85); the cell looks up
    // the start of its day (:107). They agree unless midnight itself was skipped by DST.
    const direct = dailyPnL.get(date);
    monthTotal += direct ?? 0;
    if (direct !== undefined) tradingDays += 1;
    days.push({
      date,
      dayOfMonth: d,
      pnl: dailyPnL.get(grid.startOfDay(date)) ?? null,
      isToday: ctx.calendar.isSameDay(date, ctx.now),
    });
  }
  const firstWeekday = grid.weekStart;
  const first = days[0];
  const leadingBlankCount = first === undefined ? 0 : (grid.weekday(first.date) - firstWeekday + 7) % 7;
  const weekdayHeaders =
    ctx.brand === "dojix" ? [1, 2, 3, 4, 5, 6, 7] : Array.from({ length: 7 }, (_, i) => ((firstWeekday - 1 + i) % 7) + 1);
  return {
    month,
    year,
    monthNumber,
    days,
    leadingBlankCount,
    firstWeekday,
    weekdayHeaders,
    weekdayHeaderNames: weekdayHeaders.map((w) => POSIX_WEEKDAY_NAMES[w - 1] as string),
    monthTotal,
    tradingDays,
    dailyPnL,
  };
}
