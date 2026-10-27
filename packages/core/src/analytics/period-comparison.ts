// PeriodComparison (Dojix Overview, Greenwick Sessions). SPEC Appendix A "PeriodComparison".
//
// Dojix `Components/PeriodComparison.swift:9-93,229-255`; Greenwick's copy is identical. Both
// use `Calendar.current` and `Date()`: the computer's calendar (`ctx.localCalendar`) and
// `ctx.now`, also in Greenwick.
//
// - Week / Month / Quarter = 7 / 30 / 90 days back (`date(byAdding: .day, …)`: wall-clock days);
// - current = close ≥ now − d; previous = now − 2d ≤ close < now − d;
// - MetricsCalculator on each side; rows P&L, Win Rate, Profit Factor, Avg R, Trades, Max DD;
// - %change(c, p) = p == 0 ? (c > 0 ? 100 : c < 0 ? −100 : 0) : (c − p) / |p| × 100; Win Rate
//   and Avg R show the plain difference instead;
// - without previous trades the previous value and the change show "–".
//
// Parity trap (kept): a profit factor of +∞ (no losses) on either side makes the PF change
// ±∞ or NaN, which the Mac prints as "inf%" / "nan%".

import type { EngineContext } from "../engine/context";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import { asCompactCurrency, asPercent, asProfitFactor, asRMultiple, formatFixed } from "../swiftcompat/format";

export type ComparisonPeriod = "week" | "month" | "quarter";

/** `Period.daysBack` (PeriodComparison.swift:16-22). */
export const PERIOD_DAYS_BACK: Readonly<Record<ComparisonPeriod, number>> = { week: 7, month: 30, quarter: 90 };

/** `Period.rawValue`, the pill labels. */
export const PERIOD_LABEL: Readonly<Record<ComparisonPeriod, string>> = { week: "Week", month: "Month", quarter: "Quarter" };

export type ComparisonId = "pnl" | "wr" | "pf" | "avgr" | "trades" | "dd";

export interface ComparisonMetric {
  id: ComparisonId;
  label: string;
  currentValue: number;
  previousValue: number;
  /** The Mac's formatted values (`asCompactCurrency`, `asPercent`, …). */
  current: string;
  previous: string;
  /** Percent change, or the plain difference for Win Rate and Avg R. */
  change: number;
  isPositiveGood: boolean;
  /** "%" for percent changes, "" for the plain differences. */
  changeSuffix: "%" | "";
  /** Arrow: up (> 0), down (< 0), flat otherwise (also NaN). */
  direction: "up" | "down" | "flat";
  /** good / bad / neutral colouring (green, red, grey). */
  tone: "good" | "bad" | "neutral";
  /** `String(format: "%.1f", abs(change))` + suffix, as shown in the CHANGE column. */
  changeText: string;
}

export interface PeriodComparisonModel {
  period: ComparisonPeriod;
  /** now − d and now − 2d, epoch ms. */
  currentCutoff: number;
  previousCutoff: number;
  currentPeriodTrades: Trade[];
  previousPeriodTrades: Trade[];
  current: PortfolioMetrics;
  previous: PortfolioMetrics;
  comparisons: ComparisonMetric[];
  /** False shows "–" in the PREVIOUS and CHANGE columns. */
  hasPrevious: boolean;
  /** Both periods empty: "No trades in selected periods". */
  isEmpty: boolean;
}

/** `percentChange(_:_:)` (PeriodComparison.swift:252-255). */
export function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function metric(
  id: ComparisonId,
  label: string,
  currentValue: number,
  previousValue: number,
  current: string,
  previous: string,
  change: number,
  isPositiveGood: boolean,
): ComparisonMetric {
  const changeSuffix = id === "wr" || id === "avgr" ? "" : "%";
  const isGood = isPositiveGood ? change > 0 : change < 0;
  const isBad = isPositiveGood ? change < 0 : change > 0;
  return {
    id,
    label,
    currentValue,
    previousValue,
    current,
    previous,
    change,
    isPositiveGood,
    changeSuffix,
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
    tone: isGood ? "good" : isBad ? "bad" : "neutral",
    changeText: formatFixed(Math.abs(change), 1) + changeSuffix,
  };
}

export function periodComparison(ctx: EngineContext, trades: readonly Trade[], period: ComparisonPeriod = "month"): PeriodComparisonModel {
  const days = PERIOD_DAYS_BACK[period];
  const currentCutoff = ctx.localCalendar.addDays(ctx.now, -days);
  const previousCutoff = ctx.localCalendar.addDays(ctx.now, -days * 2);
  const currentPeriodTrades = trades.filter((t) => t.closeTime >= currentCutoff);
  const previousPeriodTrades = trades.filter((t) => t.closeTime >= previousCutoff && t.closeTime < currentCutoff);
  const options = { brand: ctx.brand, compat: ctx.compat };
  const c = calculateMetrics(currentPeriodTrades, options);
  const p = calculateMetrics(previousPeriodTrades, options);
  const comparisons = [
    metric("pnl", "P&L", c.totalProfit, p.totalProfit, asCompactCurrency(c.totalProfit), asCompactCurrency(p.totalProfit), percentChange(c.totalProfit, p.totalProfit), true),
    metric("wr", "Win Rate", c.winRate, p.winRate, asPercent(c.winRate), asPercent(p.winRate), c.winRate - p.winRate, true),
    metric(
      "pf",
      "Profit Factor",
      c.profitFactor,
      p.profitFactor,
      asProfitFactor(c.profitFactor),
      asProfitFactor(p.profitFactor),
      percentChange(c.profitFactor, p.profitFactor),
      true,
    ),
    metric(
      "avgr",
      "Avg R",
      c.averageRMultiple,
      p.averageRMultiple,
      asRMultiple(c.averageRMultiple),
      asRMultiple(p.averageRMultiple),
      c.averageRMultiple - p.averageRMultiple,
      true,
    ),
    metric("trades", "Trades", c.totalTrades, p.totalTrades, String(c.totalTrades), String(p.totalTrades), percentChange(c.totalTrades, p.totalTrades), true),
    metric("dd", "Max DD", c.maxDrawdown, p.maxDrawdown, asCompactCurrency(c.maxDrawdown), asCompactCurrency(p.maxDrawdown), percentChange(c.maxDrawdown, p.maxDrawdown), false),
  ];
  return {
    period,
    currentCutoff,
    previousCutoff,
    currentPeriodTrades,
    previousPeriodTrades,
    current: c,
    previous: p,
    comparisons,
    hasPrevious: previousPeriodTrades.length > 0,
    isEmpty: currentPeriodTrades.length === 0 && previousPeriodTrades.length === 0,
  };
}
