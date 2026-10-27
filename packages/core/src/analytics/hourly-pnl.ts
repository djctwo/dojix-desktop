// HourlyPnLChart (Timing tab, both brands). SPEC Appendix A "HourlyPnL".
//
// Dojix `Components/HourlyPnLChart.swift:8-16,26`; Greenwick `Components/HourlyPnLChart.swift`
// (identical math; the stored hour is UTC / broker time in Dojix and the ET hour of the open
// in Greenwick).
//
// - hours 0–23 by the stored hour; hours without trades are dropped;
// - P&L summed in input order;
// - best = `max(by: { $0.pnl < $1.pnl })`, so the **last** of equal maxima.

import type { EngineContext } from "../engine/context";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy } from "../swiftcompat/collections";
import { sumProfit } from "./shared";

export interface HourlyPnLRow {
  hour: number;
  pnl: number;
  count: number;
}

export interface HourlyPnLModel {
  /** Hours 0–23 that have trades, ascending. */
  hourlyData: HourlyPnLRow[];
  /** The hour with the highest P&L (the last one on ties); null without trades. */
  best: HourlyPnLRow | null;
  /** Shown next to the title (`ConfidenceBadge(sampleSize: trades.count)`). */
  sampleSize: number;
  /** "UTC" (Dojix) or "ET" (Greenwick), the title's zone. */
  zoneLabel: "UTC" | "ET";
}

export function hourlyPnL(ctx: EngineContext, trades: readonly Trade[]): HourlyPnLModel {
  const grouped = groupByFirstAppearance(trades, (t) => t.hour);
  const hourlyData: HourlyPnLRow[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const hourTrades = grouped.get(hour) ?? [];
    if (hourTrades.length > 0) hourlyData.push({ hour, pnl: sumProfit(hourTrades), count: hourTrades.length });
  }
  return {
    hourlyData,
    best: maxBy(hourlyData, (a, b) => a.pnl < b.pnl) ?? null,
    sampleSize: trades.length,
    zoneLabel: ctx.brand === "dojix" ? "UTC" : "ET",
  };
}
