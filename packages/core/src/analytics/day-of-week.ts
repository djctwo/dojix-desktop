// DayOfWeekChart (Timing tab, both brands). SPEC Appendix A "DayOfWeekChart".
//
// Dojix `Components/DayOfWeekChart.swift:16-27,73-74`: grouped by the stored `dayOfWeek` label.
// Greenwick `Components/DayOfWeekChart.swift:16-31`: grouped by the weekday of the ET trading
// day of the close (`TradingCalendar.groupedByWeekday`), so a stored "Fr." or an after-hours
// Friday close seen from Tokyo still lands on "Fri".
//
// Rows Mon…Fri only (a weekend label is ignored); best = `max(by:)` (last of ties), worst =
// `min(by:)` (first of ties).

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy, minBy } from "../swiftcompat/collections";
import { closeDayLabel, percentOf, WEEKDAY_ROWS, winCount } from "./shared";
import { sumProfit } from "./support";

export interface DayOfWeekRow {
  id: string;
  day: string;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
}

export interface DayOfWeekModel {
  /** Mon…Fri with trades, in weekday order. */
  data: DayOfWeekRow[];
  best: DayOfWeekRow | null;
  worst: DayOfWeekRow | null;
  sampleSize: number;
}

export function dayOfWeekChart(_ctx: EngineContext, trades: readonly Trade[]): DayOfWeekModel {
  const grouped = groupByFirstAppearance(trades, closeDayLabel);
  const data: DayOfWeekRow[] = [];
  for (const day of WEEKDAY_ROWS) {
    const dayTrades = grouped.get(day);
    if (!dayTrades || dayTrades.length === 0) continue;
    data.push({
      id: day,
      day,
      profit: sumProfit(dayTrades),
      tradeCount: dayTrades.length,
      winRate: percentOf(winCount(dayTrades), dayTrades.length),
    });
  }
  const less = (a: DayOfWeekRow, b: DayOfWeekRow) => a.profit < b.profit;
  return {
    data,
    best: maxBy(data, less) ?? null,
    worst: minBy(data, less) ?? null,
    sampleSize: trades.length,
  };
}
