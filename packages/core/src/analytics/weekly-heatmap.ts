// WeeklyHeatmap (Dojix Overview, Greenwick Timing). SPEC Appendix A "WeeklyHeatmap".
//
// Dojix `Components/WeeklyHeatmap.swift:15-34,48,58-61,106-113,128-139`: weeks keyed by
// (yearForWeekOfYear, weekOfYear) of the close on `Calendar.current` ("2026-W3"); the week
// start is `date(from:)` of those components.
// Greenwick `Components/WeeklyHeatmap.swift:15-25`: weeks keyed by `TradingCalendar.startOfWeek`
// of the close (Monday-start ET weeks); the id is the week start's day key.
//
// - per week: profit (input order), trade count, WR%; weeks sorted by start ascending;
// - the last 16 weeks are shown; green weeks = profit > 0; average = Σ profit / max(weeks, 1);
// - streak from the newest week back: a + week extends a + streak, a − week a − streak, a flat
//   week is skipped, a sign change stops;
// - cell opacity .1 + .3 × |p| / maxAbs for p ≠ 0.

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, minBy, stableSorted } from "../swiftcompat/collections";
import { maxAbsOr, percentOf, winCount } from "./shared";
import { sumProfit } from "./support";

export interface WeekData {
  id: string;
  /** Start of the week (00:00 of its first day), epoch ms. */
  weekStart: number;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
}

export interface WeeklyHeatmapModel {
  /** Every week with trades, oldest first. */
  weeklyData: WeekData[];
  /** The last 16 weeks (what the grid shows). */
  displayData: WeekData[];
  /** Grid columns: min(4, displayed weeks). */
  columns: number;
  profitableWeeks: number;
  totalWeeks: number;
  avgWeekly: number;
  /** +n green weeks in a row, −n red weeks, 0 when none (`calculateStreak`). */
  currentStreak: number;
  maxAbsProfit: number;
}

export const WEEKLY_HEATMAP_SHOWN_WEEKS = 16;

function weeksOf(ctx: EngineContext, trades: readonly Trade[]): WeekData[] {
  const calendar = ctx.calendar;
  const rows: WeekData[] = [];
  if (ctx.brand === "dojix") {
    const grouped = groupByFirstAppearance(trades, (t) => {
      const w = calendar.weekOfYear(t.closeTime);
      return `${w.yearForWeekOfYear}-W${w.weekOfYear}`;
    });
    for (const [key, weekTrades] of grouped) {
      const first = minBy(weekTrades, (a, b) => a.closeTime < b.closeTime) as Trade;
      const w = calendar.weekOfYear(first.closeTime);
      rows.push(week(key, calendar.startOfWeekOfYear(w.yearForWeekOfYear, w.weekOfYear), weekTrades));
    }
  } else {
    const grouped = groupByFirstAppearance(trades, (t) => calendar.startOfWeek(t.closeTime));
    for (const [weekStart, weekTrades] of grouped) rows.push(week(calendar.dayKey(weekStart), weekStart, weekTrades));
  }
  return stableSorted(rows, (a, b) => a.weekStart < b.weekStart);
}

function week(id: string, weekStart: number, weekTrades: readonly Trade[]): WeekData {
  return {
    id,
    weekStart,
    profit: sumProfit(weekTrades),
    tradeCount: weekTrades.length,
    winRate: percentOf(winCount(weekTrades), weekTrades.length),
  };
}

/** `calculateStreak()` (WeeklyHeatmap.swift:128-139). */
export function weeklyStreak(weeks: readonly Pick<WeekData, "profit">[]): number {
  let streak = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const p = (weeks[i] as Pick<WeekData, "profit">).profit;
    if (p > 0) {
      if (streak >= 0) streak += 1;
      else break;
    } else if (p < 0) {
      if (streak <= 0) streak -= 1;
      else break;
    }
  }
  return streak;
}

export function weeklyHeatmap(ctx: EngineContext, trades: readonly Trade[]): WeeklyHeatmapModel {
  const weeklyData = weeksOf(ctx, trades);
  const displayData = weeklyData.slice(Math.max(0, weeklyData.length - WEEKLY_HEATMAP_SHOWN_WEEKS));
  let total = 0;
  let profitableWeeks = 0;
  for (const w of weeklyData) {
    total += w.profit;
    if (w.profit > 0) profitableWeeks += 1;
  }
  return {
    weeklyData,
    displayData,
    columns: Math.min(4, displayData.length),
    profitableWeeks,
    totalWeeks: weeklyData.length,
    avgWeekly: total / Math.max(weeklyData.length, 1),
    currentStreak: weeklyStreak(weeklyData),
    maxAbsProfit: maxAbsOr(
      weeklyData.map((w) => w.profit),
      1,
    ),
  };
}

/** Cell fill opacity (WeeklyHeatmap.swift:106-113); null for a flat week (neutral fill). */
export function weeklyCellOpacity(profit: number, maxAbsProfit: number): number | null {
  if (!(profit > 0) && !(profit < 0)) return null;
  const intensity = maxAbsProfit > 0 ? Math.abs(profit) / maxAbsProfit : 0;
  return 0.1 + intensity * 0.3;
}
