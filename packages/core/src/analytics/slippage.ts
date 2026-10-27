// SlippageAnalysis (Pairs / Symbols tab, both brands). SPEC Appendix A "SlippageAnalysis".
//
// Dojix `Components/SlippageAnalysis.swift:8-50,84` (pips, cost = slip × $10 × lots);
// Greenwick `Components/SlippageAnalysis.swift` (points, cost = slip × shares).
//
// - trades with slippage > 0: average, estimated cost, "high slippage" count (> 2 × average);
// - distribution over **all** trades in buckets 0–0.5, 0.5–1, 1–2, 2–3, 3+ with the count and
//   the average P&L of each (0 when empty);
// - insight when the average is above 1.5.
//
// PARITY D-02 (`fixed`): the Mac's buckets are closed ranges (0...0.5, 0.5...1.0, …,
// 3.0...100.0), so a value on an edge is counted twice and a value above 100 in none. The
// desktop uses half-open buckets [0,.5), [.5,1), [1,2), [2,3) and an open-ended [3, ∞).

import type { EngineContext } from "../engine/context";
import { profitDouble, quantity, slippage } from "../model/accessors";
import type { Trade } from "../model/trade";

export interface SlippageBucket {
  id: string;
  label: string;
  count: number;
  avgPnL: number;
}

export interface SlippageAnalysisModel {
  tradesWithSlippage: Trade[];
  /** Average of the positive slippages (pips / points), 0 when none. */
  avgSlippage: number;
  /** Approximate dollars lost to slippage. */
  totalSlippageCost: number;
  /** Trades with slippage above twice the average. */
  highSlippageTrades: number;
  buckets: SlippageBucket[];
  /** avgSlippage > 1.5: "Average slippage of … is high." */
  showHighSlippageInsight: boolean;
  /** "pips" (Dojix) or "pts" (Greenwick). */
  unit: "pips" | "pts";
}

interface Range {
  label: string;
  low: number;
  high: number;
}

/** SlippageAnalysis.swift:37-43. */
export const SLIPPAGE_RANGES: readonly Range[] = [
  { label: "0-0.5", low: 0, high: 0.5 },
  { label: "0.5-1", low: 0.5, high: 1.0 },
  { label: "1-2", low: 1.0, high: 2.0 },
  { label: "2-3", low: 2.0, high: 3.0 },
  { label: "3+", low: 3.0, high: 100.0 },
];

function inRange(value: number, range: Range, fixed: boolean, last: boolean): boolean {
  if (!fixed) return range.low <= value && value <= range.high;
  return range.low <= value && (last || value < range.high);
}

export function slippageAnalysis(ctx: EngineContext, trades: readonly Trade[]): SlippageAnalysisModel {
  const tradesWithSlippage = trades.filter((t) => slippage(t) > 0);
  let total = 0;
  for (const t of tradesWithSlippage) total += slippage(t);
  const avgSlippage = tradesWithSlippage.length === 0 ? 0 : total / tradesWithSlippage.length;
  let totalSlippageCost = 0;
  for (const t of tradesWithSlippage) {
    // Dojix: slippagePips * 10 * lots ($10 per pip per lot); Greenwick: slippagePoints * shares.
    totalSlippageCost += ctx.brand === "dojix" ? slippage(t) * 10 * quantity(t) : slippage(t) * quantity(t);
  }
  const highSlippageTrades = tradesWithSlippage.filter((t) => slippage(t) > avgSlippage * 2).length;
  const fixed = ctx.compat === "fixed";
  const buckets = SLIPPAGE_RANGES.map((range, i) => {
    const matching = trades.filter((t) => inRange(slippage(t), range, fixed, i === SLIPPAGE_RANGES.length - 1));
    let sum = 0;
    for (const t of matching) sum += profitDouble(t);
    return { id: range.label, label: range.label, count: matching.length, avgPnL: matching.length === 0 ? 0 : sum / matching.length };
  });
  return {
    tradesWithSlippage,
    avgSlippage,
    totalSlippageCost,
    highSlippageTrades,
    buckets,
    showHighSlippageInsight: avgSlippage > 1.5,
    unit: ctx.brand === "dojix" ? "pips" : "pts",
  };
}
