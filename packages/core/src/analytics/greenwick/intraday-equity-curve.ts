// IntradayEquityCurve (Greenwick `Components/IntradayEquityCurve.swift`): average P&L per stored
// ET hour 9–15, cumulated across the day, and morning (9–11) vs afternoon (12–15) totals.

import type { GreenwickTrade } from "../../model/trade";
import { seqMax, swiftMax } from "../../swiftcompat/collections";
import { sumProfit } from "./shared";

export interface IntradayHourBucket {
  hour: number;
  /** "9:30" for hour 9, else "H:00". */
  label: string;
  avgPnL: number;
  tradeCount: number;
  /** Running sum of the hourly averages. */
  cumulativePnL: number;
}

export interface IntradayEquityCurveModel {
  /** Some trade falls in hours 9–15 (else "No trades during regular market hours"). */
  hasMarketHourTrades: boolean;
  /** Hours 9…15 in order (empty hours have 0). */
  hourBuckets: IntradayHourBucket[];
  /** Net P&L of hours 9–11 (9:30–12:00). */
  morningPnL: number;
  /** Net P&L of hours 12–15 (12:00–16:00). */
  afternoonPnL: number;
  insightText: string;
  /** max(|cumulative|) with a floor of 1 (chart scale). */
  maxAbsCumulative: number;
}

/** `marketHours` (:20). */
export const INTRADAY_HOURS: readonly number[] = [9, 10, 11, 12, 13, 14, 15];

/** `hourLabel` (:251-254). */
export function intradayHourLabel(hour: number): string {
  return hour === 9 ? "9:30" : `${hour}:00`;
}

/** :45-61 — the per-hour sums are added to the running total one hour at a time. */
function sessionPnL(grouped: ReadonlyMap<number, GreenwickTrade[]>, from: number, to: number): number {
  let total = 0;
  for (let h = from; h <= to; h++) total += sumProfit(grouped.get(h) ?? []);
  return total;
}

/** IntradayEquityCurve.swift:22-82. The card needs 10 trades (the registry guard). */
export function computeIntradayEquityCurve(trades: readonly GreenwickTrade[]): IntradayEquityCurveModel {
  const grouped = new Map<number, GreenwickTrade[]>();
  for (const t of trades) {
    const g = grouped.get(t.hour);
    if (g) g.push(t);
    else grouped.set(t.hour, [t]);
  }

  let cumulative = 0;
  const hourBuckets = INTRADAY_HOURS.map((hour): IntradayHourBucket => {
    const hourTrades = grouped.get(hour) ?? [];
    const avg = hourTrades.length === 0 ? 0 : sumProfit(hourTrades) / hourTrades.length;
    cumulative += avg;
    return { hour, label: intradayHourLabel(hour), avgPnL: avg, tradeCount: hourTrades.length, cumulativePnL: cumulative };
  });

  const morningPnL = sessionPnL(grouped, 9, 11);
  const afternoonPnL = sessionPnL(grouped, 12, 15);

  // insightText (:63-74)
  let insightText: string;
  if (morningPnL > 0 && afternoonPnL < 0) insightText = "You make money in the morning and give it back after lunch";
  else if (morningPnL < 0 && afternoonPnL > 0) insightText = "Slow start but your edge is strongest in the afternoon";
  else if (morningPnL > 0 && afternoonPnL > 0) {
    const stronger = morningPnL > afternoonPnL ? "morning" : "afternoon";
    insightText = `Profitable all day -- ${stronger} is your strongest session`;
  } else insightText = "Negative P&L across both sessions -- review trade selection";

  const absMax = seqMax(hourBuckets.map((b) => Math.abs(b.cumulativePnL))) ?? 1;
  return {
    hasMarketHourTrades: hourBuckets.some((b) => b.tradeCount > 0),
    hourBuckets,
    morningPnL,
    afternoonPnL,
    insightText,
    maxAbsCumulative: swiftMax(absMax, 1),
  };
}
