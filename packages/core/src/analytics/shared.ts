// Helpers shared by the E2 analytics components (Timing, Sessions, Pairs/Symbols, Overview).
//
// Every helper sums in input order, the order the Mac's `reduce` walks (the repository returns
// trades by close time descending), so the floating-point results match bit for bit.

import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import { idiv } from "../swiftcompat/int";
import { entryWeekday, tradingWeekday } from "../time/us-market";

/** `trades.filter(\.isWin).count` (Decimal comparison). */
export function winCount(trades: readonly Trade[]): number {
  let n = 0;
  for (const t of trades) if (isWin(t)) n += 1;
  return n;
}

/** `trades.filter { $0.profitDouble > 0 }.count` (Double comparison; PerformanceSummary, PairAnalytics). */
export function positiveProfitCount(trades: readonly Trade[]): number {
  let n = 0;
  for (const t of trades) if (profitDouble(t) > 0) n += 1;
  return n;
}

/** `Double(wins) / Double(n) * 100`; callers guard n > 0 where the Mac does. */
export function percentOf(count: number, n: number): number {
  return (count / n) * 100;
}

/** `trades.map(\.rMultiple).reduce(0, +) / Double(trades.count)`. */
export function meanR(trades: readonly Trade[]): number {
  let total = 0;
  for (const t of trades) total += t.rMultiple;
  return total / trades.length;
}

/** `[Double].sorted()` (ascending, stable). */
export function sortedAscending(values: readonly number[]): number[] {
  return stableSorted(values, (a, b) => a < b);
}

/**
 * The median the Mac components compute: sort ascending, `mid = count / 2` (integer
 * division), mean of the two middle values when the count is even. Null when empty.
 * WinLossDistribution.swift:77-85, RMultipleChart.swift:90-95.
 */
export function swiftMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = sortedAscending(values);
  const mid = idiv(sorted.length, 2);
  if (sorted.length % 2 === 0) return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return sorted[mid] as number;
}

/** Monday to Friday, the rows of the day charts and heatmaps (both apps). */
export const WEEKDAY_ROWS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;

/**
 * The weekday a heatmap files a trade under, next to its stored hour: Dojix the stored
 * `dayOfWeek` label; Greenwick the ET weekday of the **open** (`entryWeekday`), which pairs
 * with the stored ET hour of the open (TradeTimeHeatmap.swift:22, SessionHeatmap.swift:132).
 */
export function entryDayLabel(t: Trade): string {
  return t.brand === "dojix" ? t.dayOfWeek : entryWeekday(t);
}

/**
 * The weekday the day-of-week chart files a trade under: Dojix the stored label; Greenwick the
 * weekday of the ET trading day of the **close** (DayOfWeekChart.swift:19 / Greenwick :21).
 */
export function closeDayLabel(t: Trade): string {
  return t.brand === "dojix" ? t.dayOfWeek : tradingWeekday(t);
}

/** Swift `[Double].max()` of absolute values, with the Mac's `?? fallback`. */
export function maxAbsOr(values: Iterable<number>, fallback: number): number {
  let have = false;
  let result = 0;
  for (const v of values) {
    const a = Math.abs(v);
    // max(by: <): a later element replaces the result unless it is smaller.
    if (!have || !(a < result)) {
      result = a;
      have = true;
    }
  }
  return have ? result : fallback;
}
