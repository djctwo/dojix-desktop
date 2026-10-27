// ExecutionQuality (Greenwick `Components/ExecutionQuality.swift`): slippage by stored ET hour
// and by symbol, and a 0–100 execution score.
//
// - The hour and symbol tables use only trades with slippage > 0; the score uses every trade
//   (negative slippage, a price improvement, lowers the average).
// - score = 0.4 · clamp((1 − avgSlip / 3) × 100) + 0.3 · clamp((1 − σ / 2) × 100)
//   + 0.3 · average exit efficiency (50 when no trade has one); σ is the population deviation.
// - Exit efficiency needs a known positive MFE in both compat modes, so D-18 changes nothing.

import type { CompatMode } from "../../engine/compat";
import { exitEfficiency } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";
import { maxBy, seqMax, stableSorted, swiftMax, swiftMin } from "../../swiftcompat/collections";
import { groupByString } from "./shared";

export interface HourSlippage {
  hour: number;
  avgSlippage: number;
  tradeCount: number;
}

export interface SymbolSlippage {
  symbol: string;
  tradeCount: number;
  avgSlippage: number;
  /** Average slippage × average shares. */
  estimatedCost: number;
}

export type ExecutionScoreLabel = "Good" | "Fair" | "Poor";

export interface ExecutionQualityModel {
  /** Trades with slippage > 0, input order. */
  tradesWithSlippage: GreenwickTrade[];
  /** By stored ET hour, ascending. */
  hourlySlippage: HourSlippage[];
  /** Highest average slippage (last of ties in hour order). */
  worstHour: HourSlippage | null;
  /** Largest bar (chart scale), 1 when empty. */
  maxHourlySlippage: number;
  /** Top 5 symbols by average slippage, descending (ties: first appearance). */
  symbolSlippage: SymbolSlippage[];
  slippageScore: number;
  consistencyScore: number;
  avgEfficiency: number;
  executionScore: number;
  /** > 70 Good, ≥ 40 Fair, else Poor. */
  scoreLabel: ExecutionScoreLabel;
}

/** ExecutionQuality.swift:64-90 (0 for no trades). */
export function executionScoreParts(
  trades: readonly GreenwickTrade[],
  compat: CompatMode,
): { slippageScore: number; consistencyScore: number; avgEfficiency: number; executionScore: number } {
  if (trades.length === 0) return { slippageScore: 0, consistencyScore: 0, avgEfficiency: 0, executionScore: 0 };
  const slips = trades.map((t) => t.slippagePoints);
  let sum = 0;
  for (const s of slips) sum += s;
  const avgSlip = sum / slips.length;
  const slippageScore = swiftMax(0, swiftMin(100, (1 - avgSlip / 3.0) * 100));
  let sq = 0;
  for (const s of slips) sq += (s - avgSlip) * (s - avgSlip);
  const stdDev = Math.sqrt(sq / slips.length);
  const consistencyScore = swiftMax(0, swiftMin(100, (1 - stdDev / 2.0) * 100));
  const efficiencies: number[] = [];
  for (const t of trades) {
    const e = exitEfficiency(t, compat);
    if (e !== null) efficiencies.push(e);
  }
  let avgEfficiency = 50;
  if (efficiencies.length > 0) {
    let e = 0;
    for (const x of efficiencies) e += x;
    avgEfficiency = e / efficiencies.length;
  }
  return {
    slippageScore,
    consistencyScore,
    avgEfficiency,
    executionScore: slippageScore * 0.4 + consistencyScore * 0.3 + avgEfficiency * 0.3,
  };
}

/** `scoreLabel` (:98-102). */
export function executionScoreLabel(score: number): ExecutionScoreLabel {
  if (score > 70) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

function avgOf(trades: readonly GreenwickTrade[], f: (t: GreenwickTrade) => number): number {
  let total = 0;
  for (const t of trades) total += f(t);
  return total / trades.length;
}

/**
 * ExecutionQuality.swift:26-102. The card needs 10 trades (the registry guard) and some
 * slippage ("No slippage data available" when `tradesWithSlippage` is empty).
 */
export function computeExecutionQuality(trades: readonly GreenwickTrade[], compat: CompatMode): ExecutionQualityModel {
  const tradesWithSlippage = trades.filter((t) => t.slippagePoints > 0);

  // :30-37 — `Dictionary(grouping:) { $0.hour }`, sorted by hour (unique keys).
  const byHour = new Map<number, GreenwickTrade[]>();
  for (const t of tradesWithSlippage) {
    const g = byHour.get(t.hour);
    if (g) g.push(t);
    else byHour.set(t.hour, [t]);
  }
  const hourlySlippage = [...byHour]
    .map(([hour, ts]): HourSlippage => ({ hour, avgSlippage: avgOf(ts, (t) => t.slippagePoints), tradeCount: ts.length }))
    .sort((a, b) => a.hour - b.hour);

  // :43-60
  const symbolRows = groupByString(tradesWithSlippage, (t) => t.symbol).map(({ label, items }): SymbolSlippage => {
    const avgSlippage = avgOf(items, (t) => t.slippagePoints);
    const avgShares = avgOf(items, (t) => t.shares);
    return { symbol: label, tradeCount: items.length, avgSlippage, estimatedCost: avgSlippage * avgShares };
  });
  const symbolSlippage = stableSorted(symbolRows, (a, b) => a.avgSlippage > b.avgSlippage).slice(0, 5);

  const parts = executionScoreParts(trades, compat);
  return {
    tradesWithSlippage,
    hourlySlippage,
    worstHour: maxBy(hourlySlippage, (a, b) => a.avgSlippage < b.avgSlippage) ?? null,
    maxHourlySlippage: seqMax(hourlySlippage.map((h) => h.avgSlippage)) ?? 1,
    symbolSlippage,
    ...parts,
    scoreLabel: executionScoreLabel(parts.executionScore),
  };
}
