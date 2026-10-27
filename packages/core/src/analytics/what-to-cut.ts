// WhatToCutAdvisor (Sessions tab, both brands). SPEC Appendix A "WhatToCut".
//
// Dojix `Components/WhatToCutAdvisor.swift:11-33,200-207,219-237`: trading days = distinct
// `Calendar.current` days of the close. Greenwick (:11-12, 210-223): `TradingCalendar.
// tradingDayCount` (ET close days). Both are `tradingDayCount(trades, ctx.calendar)`, at least 1.
//
// - needs n ≥ 30;
// - every edge condition (`allEdgeConditions`) with expectancy < 0 and ≥ 10 trades, sorted by
//   monthly impact ascending (stable; the Mac's order of equal impacts is random, the desktop
//   keeps first appearance);
// - total potential savings = Σ monthly impact (negative; the banner shows |total|);
// - the single biggest improvement = the first condition.

import type { EngineContext } from "../engine/context";
import { allEdgeConditions, type EdgeCondition } from "../metrics/edges";
import { tradingDayCount } from "../metrics/trading-days";
import type { Trade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import { formatFixed } from "../swiftcompat/format";

export const WHAT_TO_CUT_MIN_TRADES = 30;

export interface WhatToCutModel {
  /** Distinct close days (brand calendar), at least 1. */
  tradingDays: number;
  negativeConditions: EdgeCondition[];
  /** Σ monthly impact of the negative conditions (≤ 0). */
  totalPotentialSavings: number;
  worstCondition: EdgeCondition | null;
  /** n ≥ 30; below it the card shows "Need at least 30 trades…". */
  hasEnoughData: boolean;
}

export function whatToCut(ctx: EngineContext, trades: readonly Trade[]): WhatToCutModel {
  const tradingDays = Math.max(tradingDayCount(trades, ctx.calendar, "close"), 1);
  const negativeConditions = stableSorted(
    allEdgeConditions(trades, tradingDays, ctx.brand).filter((c) => c.expectancy < 0 && c.tradeCount >= 10),
    (a, b) => a.monthlyImpact < b.monthlyImpact,
  );
  let totalPotentialSavings = 0;
  for (const c of negativeConditions) totalPotentialSavings += c.monthlyImpact;
  return {
    tradingDays,
    negativeConditions,
    totalPotentialSavings,
    worstCondition: negativeConditions[0] ?? null,
    hasEnoughData: trades.length >= WHAT_TO_CUT_MIN_TRADES,
  };
}

/** The exported table, header first (WhatToCutAdvisor.swift:201-206 / Greenwick `csvRows`). */
export function whatToCutCsvRows(model: Pick<WhatToCutModel, "negativeConditions" | "totalPotentialSavings">): string[][] {
  const rows: string[][] = [["Dimension", "Condition", "P&L", "Win Rate", "Trades", "Expectancy", "Profit Factor", "Monthly Impact"]];
  for (const c of model.negativeConditions) {
    rows.push([
      c.dimension,
      c.label,
      formatFixed(c.profit, 2),
      formatFixed(c.winRate, 1),
      String(c.tradeCount),
      formatFixed(c.expectancy, 2),
      formatFixed(c.profitFactor, 2),
      formatFixed(c.monthlyImpact, 2),
    ]);
  }
  rows.push([]);
  rows.push(["Total Potential Savings (monthly)", formatFixed(model.totalPotentialSavings, 2)]);
  return rows;
}
