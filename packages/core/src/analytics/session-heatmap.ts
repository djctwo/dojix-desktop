// SessionHeatmap (Sessions tab, both brands). SPEC Appendix A "SessionHeatmap".
//
// Dojix `Components/SessionHeatmap.swift:8,109-174`; Greenwick keys by the ET weekday of the
// open (`entryWeekday`, :130) and formats the date range in New York time (:112-113).
//
// - active hours = the distinct stored hours, ascending (a weekend trade's hour still adds a
//   column);
// - cells Mon–Fri × active hours (key "<day>-<hour>", P&L in input order);
// - maxAbs over the cells (`?? 1`); opacity .2 + .8 × min(|p| / maxAbs, 1) for p ≠ 0;
// - subtitle "MMM d – MMM d, yyyy · N active hour(s) · N trades" of the first and last close.

import type { EngineContext } from "../engine/context";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, stableSorted, swiftMin } from "../swiftcompat/collections";
import type { ZonedCalendar } from "../time/zoned-calendar";
import { entryDayLabel, maxAbsOr, sumProfit, WEEKDAY_ROWS } from "./shared";

export interface SessionHeatmapCell {
  id: string;
  hour: number;
  day: string;
  profit: number;
  tradeCount: number;
}

export interface SessionHeatmapModel {
  /** Mon–Fri × active hours, Monday first. */
  heatmapData: SessionHeatmapCell[];
  sortedActiveHours: number[];
  maxAbsProfit: number;
  /** First and last close (ascending), null without trades. */
  firstClose: number | null;
  lastClose: number | null;
  /** The Mac subtitle with en-US month names ("" without trades). */
  dateRangeLabel: string;
  totalTrades: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthDay(calendar: ZonedCalendar, t: number): string {
  const f = calendar.fields(t);
  return `${MONTHS[f.month - 1] as string} ${f.day}`;
}

/** `DateFormatter` "MMM d" … ", yyyy" in the brand calendar's zone, en_US_POSIX. */
export function sessionHeatmapDateRange(calendar: ZonedCalendar, first: number, last: number, hours: number, trades: number): string {
  const year = String(calendar.fields(last).year).padStart(4, "0");
  return `${monthDay(calendar, first)} – ${monthDay(calendar, last)}, ${year} · ${hours} active hour${hours === 1 ? "" : "s"} · ${trades} trades`;
}

export function sessionHeatmap(ctx: EngineContext, trades: readonly Trade[]): SessionHeatmapModel {
  const sortedActiveHours = stableSorted([...new Set(trades.map((t) => t.hour))], (a, b) => a < b);
  const grouped = groupByFirstAppearance(trades, (t) => `${entryDayLabel(t)}-${t.hour}`);
  const heatmapData: SessionHeatmapCell[] = [];
  for (const day of WEEKDAY_ROWS) {
    for (const hour of sortedActiveHours) {
      const key = `${day}-${hour}`;
      const dayTrades = grouped.get(key) ?? [];
      heatmapData.push({ id: key, hour, day, profit: sumProfit(dayTrades), tradeCount: dayTrades.length });
    }
  }
  const sorted = sortedByCloseAscending(trades);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    heatmapData,
    sortedActiveHours,
    maxAbsProfit: maxAbsOr(
      heatmapData.map((c) => c.profit),
      1.0,
    ),
    firstClose: first?.closeTime ?? null,
    lastClose: last?.closeTime ?? null,
    dateRangeLabel:
      first === undefined || last === undefined
        ? ""
        : sessionHeatmapDateRange(ctx.calendar, first.closeTime, last.closeTime, sortedActiveHours.length, trades.length),
    totalTrades: trades.length,
  };
}

/** Fill opacity of a cell (SessionHeatmap.swift:158-170); null = the neutral inset fill. */
export function sessionHeatmapOpacity(cell: Pick<SessionHeatmapCell, "profit" | "tradeCount">, maxAbsProfit: number): number | null {
  if (cell.tradeCount === 0 || !(cell.profit > 0 || cell.profit < 0)) return null;
  return 0.2 + swiftMin(Math.abs(cell.profit) / maxAbsProfit, 1.0) * 0.8;
}
