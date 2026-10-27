// PerformanceSummary (Dojix Overview, Greenwick Sessions). SPEC Appendix A "PerformanceSummary".
//
// Dojix `Components/PerformanceSummary.swift:7-35,39-42,88-95` on `Calendar.current` (the
// display calendar); Greenwick on `TradingCalendar.calendar` (Monday-start ET weeks and ET
// months, :7-8) with the daily sparkline from `TradingCalendar.dailyPnL` (:90-91). Both are
// `ctx.calendar`.
//
// - This Week: close ≥ start of now's week; This Month: close ≥ start of now's month (no upper
//   bound in either); Last Month: [start of last month, start of this month);
// - P&L summed in input order; wins counted as `profitDouble > 0` (a Double comparison, unlike
//   `isWin`); WR% = 0 without trades;
// - sparkline: P&L per day of the close, days ascending; maxAbs = max |day| (`?? 1`).

import type { EngineContext } from "../engine/context";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { maxAbsOr, percentOf, positiveProfitCount, sumProfit } from "./shared";

export interface DailyBar {
  /** Start of the day, epoch ms. */
  day: number;
  pnl: number;
}

export interface PeriodCard {
  title: "This Week" | "This Month" | "Last Month";
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end (Last Month only), epoch ms. */
  end: number | null;
  trades: Trade[];
  pnl: number;
  tradeCount: number;
  /** Percent; 0 without trades. */
  winRate: number;
  /** Daily sparkline, oldest first (empty without trades). */
  daily: DailyBar[];
  /** Largest |daily P&L|, 1 without days. */
  maxAbsDaily: number;
}

export interface PerformanceSummaryModel {
  thisWeek: PeriodCard;
  thisMonth: PeriodCard;
  lastMonth: PeriodCard;
}

function card(ctx: EngineContext, title: PeriodCard["title"], start: number, end: number | null, all: readonly Trade[]): PeriodCard {
  const trades = all.filter((t) => t.closeTime >= start && (end === null || t.closeTime < end));
  const byDay = new Map<number, number>();
  for (const t of trades) {
    const day = ctx.calendar.startOfDay(t.closeTime);
    byDay.set(day, (byDay.get(day) ?? 0) + profitDouble(t));
  }
  const daily = [...byDay].map(([day, pnl]) => ({ day, pnl })).sort((a, b) => a.day - b.day);
  return {
    title,
    start,
    end,
    trades,
    pnl: sumProfit(trades),
    tradeCount: trades.length,
    winRate: trades.length === 0 ? 0 : percentOf(positiveProfitCount(trades), trades.length),
    daily,
    maxAbsDaily: maxAbsOr(
      daily.map((d) => d.pnl),
      1,
    ),
  };
}

export function performanceSummary(ctx: EngineContext, trades: readonly Trade[]): PerformanceSummaryModel {
  const cal = ctx.calendar;
  const thisMonthStart = cal.startOfMonth(ctx.now);
  const lastMonthStart = cal.startOfMonth(cal.addMonths(ctx.now, -1));
  return {
    thisWeek: card(ctx, "This Week", cal.startOfWeek(ctx.now), null, trades),
    thisMonth: card(ctx, "This Month", thisMonthStart, null, trades),
    lastMonth: card(ctx, "Last Month", lastMonthStart, thisMonthStart, trades),
  };
}

/**
 * Sparkline bar height in points (PerformanceSummary.swift:99): max(|p| / maxAbs × 24, 2).
 * Display only; a 0/0 (every day flat) gives the 2-point minimum here instead of Swift's NaN.
 */
export function sparklineBarHeight(pnl: number, maxAbsDaily: number): number {
  const h = (Math.abs(pnl) / maxAbsDaily) * 24;
  return h >= 2 ? h : 2;
}
