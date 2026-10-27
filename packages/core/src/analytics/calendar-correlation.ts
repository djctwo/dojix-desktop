// CalendarCorrelation (SPEC Appendix A "CalendarCorrelation / EventImpactProfiler"): event-day vs
// quiet-day performance, using recurring-event heuristics on the trade's open time.
//
// Port of Dojix `Components/CalendarCorrelation.swift:9-11,185-324` and Greenwick
// `Components/CalendarCorrelation.swift:9-11,185-309`.
//
// Brand differences (knownEventsForDate):
// - Dojix reads weekday / weekOfMonth / day / month / hour with `Calendar.current` (the display
//   calendar, `ctx.calendar`); events NFP, FOMC, ECB (Thu, day 7–21, hour 11–15), CPI, BOE (Thu,
//   day 1–14, hour 10–14), Monday Open (hour < 9), Friday Close (hour ≥ 18).
// - Greenwick reads them with `TradingCalendar.calendar` (ET, Monday-first, minDays 4); no ECB/BOE;
//   Monday Open is hour < 10 and Friday Close hour ≥ 15.
//
// Divergences (fixed mode only):
// - D-09 (Dojix): the heuristics read the open time in UTC instead of the display calendar.
// - D-19 (both): NFP "week 1" means the first Friday of the month (day 1–7). On the Mac it is
//   `weekOfMonth == 1`, which depends on the locale week (Dojix) or, for Greenwick's Monday/minDays-4
//   weeks, misses months that start on a Friday (that Friday is week 0) — and with Sunday-first,
//   minDays-1 weeks it can also match the *second* Friday.
//
// Swift traps:
// - `eventBreakdown` is a Dictionary; the view sorts it by count (unstable for ties). The desktop
//   keeps first-appearance order and sorts stably.
// - Win rates here are fractions (0–1); average R ignores trades with R == 0.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import { UTC_POSIX_CALENDAR, type ZonedCalendar } from "../time/zoned-calendar";
import { toRef, type ComponentParity } from "./support";

// --- shared news heuristics fields (also used by EventImpactProfiler) -------------------------

export interface NewsDateFields {
  /** 1 = Sunday … 7 = Saturday. */
  weekday: number;
  weekOfMonth: number;
  day: number;
  month: number;
  hour: number;
  /**
   * The NFP / jobs-report "week 1" test: `weekOfMonth == 1` on the Mac; the first Friday of the
   * month (day ≤ 7) in fixed mode (D-19).
   */
  isFirstWeek: boolean;
}

/** The calendar the news heuristics read: Dojix display calendar (UTC in fixed mode, D-09); Greenwick ET. */
export function newsCalendar(ctx: EngineContext): ZonedCalendar {
  if (ctx.brand === "dojix" && ctx.compat === "fixed") return UTC_POSIX_CALENDAR;
  return ctx.calendar;
}

/** `dateComponents([.weekday, .weekOfMonth, .day, .month, .hour], from: date)` for the heuristics. */
export function newsDateFields(ctx: EngineContext, date: number): NewsDateFields {
  const cal = newsCalendar(ctx);
  const f = cal.fields(date);
  const weekOfMonth = cal.weekOfMonth(date);
  return {
    weekday: f.weekday,
    weekOfMonth,
    day: f.day,
    month: f.month,
    hour: f.hour,
    isFirstWeek: ctx.compat === "fixed" ? f.day <= 7 : weekOfMonth === 1,
  };
}

const FOMC_MONTHS = new Set([1, 3, 5, 6, 7, 9, 11, 12]);
const ECB_MONTHS = new Set([1, 3, 4, 6, 7, 9, 10, 12]);
const BOE_MONTHS = new Set([2, 3, 5, 6, 8, 9, 11, 12]);

/** `knownEventsForDate` (Dojix :270-324, Greenwick :270-309), in the Mac's append order. */
export function knownEventsForDate(ctx: EngineContext, date: number): string[] {
  const { weekday, day, month, hour, isFirstWeek } = newsDateFields(ctx, date);
  const fx = ctx.brand === "dojix";
  const events: string[] = [];
  if (weekday === 6 && isFirstWeek) events.push("NFP (Non-Farm Payrolls)");
  if (weekday === 4 && FOMC_MONTHS.has(month) && day >= 15 && day <= 28) events.push("FOMC");
  if (fx && weekday === 5 && day >= 7 && day <= 21 && ECB_MONTHS.has(month) && hour >= 11 && hour <= 15) {
    events.push("ECB Rate Decision");
  }
  if ((weekday === 3 || weekday === 4) && day >= 10 && day <= 14) events.push("CPI Release");
  if (fx && weekday === 5 && BOE_MONTHS.has(month) && day >= 1 && day <= 14 && hour >= 10 && hour <= 14) {
    events.push("BOE Rate Decision");
  }
  if (weekday === 2 && hour < (fx ? 9 : 10)) events.push("Monday Open");
  if (weekday === 6 && hour >= (fx ? 18 : 15)) events.push("Friday Close");
  return events;
}

// --- model ---------------------------------------------------------------------------------

/** `CalendarCorrelation.EventStats` (stored count/wins/totalPnL + computed winRate/avgPnL). */
export interface EventStats {
  count: number;
  wins: number;
  totalPnL: number;
  /** Fraction 0–1. */
  winRate: number;
  avgPnL: number;
}

/** `CalendarCorrelation.EventAnalysis`. */
export interface EventAnalysis<T extends Trade = Trade> {
  eventDayTrades: T[];
  quietDayTrades: T[];
  /** Event name → stats, in first-appearance order (a Dictionary on the Mac). */
  eventBreakdown: Map<string, EventStats>;
  eventDayWinRate: number;
  quietDayWinRate: number;
  eventDayAvgPnL: number;
  quietDayAvgPnL: number;
  eventDayAvgR: number;
  quietDayAvgR: number;
}

export interface CalendarCorrelationModel<T extends Trade = Trade> {
  analysis: EventAnalysis<T>;
  /** The "BY EVENT TYPE" rows: count descending (stable), top 5. */
  topEvents: { event: string; stats: EventStats }[];
  /** The insight banner text. */
  insightText: string;
}

function winRateOf(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  let wins = 0;
  for (const t of trades) if (isWin(t)) wins += 1;
  return wins / trades.length;
}

function avgPnLOf(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  let total = 0;
  for (const t of trades) total += profitDouble(t);
  return total / trades.length;
}

function avgROf(trades: readonly Trade[]): number {
  let total = 0;
  let n = 0;
  for (const t of trades) {
    if (t.rMultiple !== 0) {
      total += t.rMultiple;
      n += 1;
    }
  }
  return n === 0 ? 0 : total / n;
}

export function computeCalendarCorrelation<T extends Trade>(ctx: EngineContext, trades: readonly T[]): CalendarCorrelationModel<T> {
  const eventDayTrades: T[] = [];
  const quietDayTrades: T[] = [];
  const raw = new Map<string, { count: number; wins: number; totalPnL: number }>();
  for (const trade of trades) {
    const events = knownEventsForDate(ctx, trade.openTime);
    if (events.length === 0) {
      quietDayTrades.push(trade);
      continue;
    }
    eventDayTrades.push(trade);
    for (const event of events) {
      const s = raw.get(event) ?? { count: 0, wins: 0, totalPnL: 0 };
      s.count += 1;
      if (isWin(trade)) s.wins += 1;
      s.totalPnL += profitDouble(trade);
      raw.set(event, s);
    }
  }
  const eventBreakdown = new Map<string, EventStats>();
  for (const [k, s] of raw) {
    eventBreakdown.set(k, {
      ...s,
      winRate: s.count > 0 ? s.wins / s.count : 0,
      avgPnL: s.count > 0 ? s.totalPnL / s.count : 0,
    });
  }
  const analysis: EventAnalysis<T> = {
    eventDayTrades,
    quietDayTrades,
    eventBreakdown,
    eventDayWinRate: winRateOf(eventDayTrades),
    quietDayWinRate: winRateOf(quietDayTrades),
    eventDayAvgPnL: avgPnLOf(eventDayTrades),
    quietDayAvgPnL: avgPnLOf(quietDayTrades),
    eventDayAvgR: avgROf(eventDayTrades),
    quietDayAvgR: avgROf(quietDayTrades),
  };
  const topEvents = stableSorted(
    [...eventBreakdown].map(([event, stats]) => ({ event, stats })),
    (a, b) => a.stats.count > b.stats.count,
  ).slice(0, 5);
  // insightBanner (:185-207)
  const diff = analysis.quietDayAvgPnL - analysis.eventDayAvgPnL;
  const amount = Math.abs(diff);
  const insightText =
    amount < 1
      ? "Your performance is similar on event and quiet days."
      : `You average $${swiftFormat("%.2f", amount)} more per trade on ${diff > 0 ? "quiet" : "event"} days.`;
  return { analysis, topEvents, insightText };
}

export const calendarCorrelationComponent = defineComponent<BrandId, CalendarCorrelationModel>({
  id: "CalendarCorrelation",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  // `if trades.count < 20 { EmptyView() }` (:14)
  minTrades: 20,
  compute: (ctx, trades) => computeCalendarCorrelation(ctx, trades),
});

export const calendarCorrelationParity: ComponentParity<CalendarCorrelationModel> = {
  component: "CalendarCorrelation",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeCalendarCorrelation(ctx, trades),
  members: { analysis: (m) => toRef(m.analysis) },
};
