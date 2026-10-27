// MAEMFEChart (Pairs / Symbols tab, both brands). SPEC Appendix A "MAEMFE".
//
// Dojix `Components/MAEMFEChart.swift:8-16,23,66-99` (pips, lots); Greenwick
// `Components/MAEMFEChart.swift` (points, shares; the ×10 is kept).
//
// - needs n ≥ 5 (scatter of MAE vs MFE);
// - avgMAE / avgMFE over all trades; ratio = avgMFE / avgMAE (0 when avgMAE = 0);
// - rating ≥ 3 Excellent, ≥ 2 Good, ≥ 1 Average, else "drawdowns exceed"; the insight is shown
//   only when avgMAE > 0;
// - capture ratio = Σ |p / max(size × 10, 1)| / Σ MFE (0 when Σ MFE ≤ 0).
//
// PARITY D-18 (`fixed`): an unknown MAE / MFE (non-MT5 imports) is null, not 0. Averages skip
// unknowns (null when nothing is known), the scatter shows trades with both values known, and
// the capture ratio uses the trades whose MFE is known. In `swift` compat unknown = 0, as the
// Mac stores it.

import type { EngineContext } from "../engine/context";
import { maeOf, mfeOf, profitDouble, quantity } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";

export const MAE_MFE_MIN_TRADES = 5;

export type MaeMfeRating = "excellent" | "good" | "average" | "poor";

/** `insightText` (MAEMFEChart.swift:81-91). */
export const MAE_MFE_INSIGHT_TEXT: Readonly<Record<MaeMfeRating, string>> = {
  excellent: "Excellent execution — MFE far exceeds MAE",
  good: "Good trade management — 2:1+ favorable ratio",
  average: "Average efficiency — consider tighter stops or better entries",
  poor: "Drawdowns exceed favorable moves — review entry timing",
};

export interface MaeMfePoint {
  mae: number;
  mfe: number;
  pnl: number;
}

export interface MaeMfeModel {
  /** n ≥ 5; below it "Need at least 5 trades". */
  enoughData: boolean;
  points: MaeMfePoint[];
  /** Null only in `fixed` mode when no trade has a known value (shown as "—"). */
  avgMAE: number | null;
  avgMFE: number | null;
  mfeToMaeRatio: number;
  captureRatio: number;
  rating: MaeMfeRating;
  /** avgMAE > 0: the insight line is shown. */
  showInsight: boolean;
  /** "pips" (Dojix) or "pts" (Greenwick). */
  unit: "pips" | "pts";
}

function mean(values: readonly (number | null)[]): number | null {
  let total = 0;
  let n = 0;
  for (const v of values) {
    if (v === null) continue;
    total += v;
    n += 1;
  }
  return n === 0 ? null : total / n;
}

export function maeMfeRating(ratio: number): MaeMfeRating {
  if (ratio >= 3) return "excellent";
  if (ratio >= 2) return "good";
  if (ratio >= 1) return "average";
  return "poor";
}

export function maeMfeChart(ctx: EngineContext, trades: readonly Trade[]): MaeMfeModel {
  const maes = trades.map((t) => maeOf(t, ctx.compat));
  const mfes = trades.map((t) => mfeOf(t, ctx.compat));
  // Swift: `guard !trades.isEmpty else { return 0 }`, then Σ / n.
  const avgMAE = trades.length === 0 ? 0 : mean(maes);
  const avgMFE = trades.length === 0 ? 0 : mean(mfes);
  const mfeToMaeRatio = avgMAE !== null && avgMFE !== null && avgMAE > 0 ? avgMFE / avgMAE : 0;

  let mfeSum = 0;
  let actual = 0;
  for (let i = 0; i < trades.length; i++) {
    const mfe = mfes[i] as number | null;
    if (mfe === null) continue;
    mfeSum += mfe;
  }
  for (let i = 0; i < trades.length; i++) {
    if (mfes[i] === null) continue;
    const t = trades[i] as Trade;
    actual += Math.abs(profitDouble(t) / swiftMax(quantity(t) * 10, 1));
  }
  const captureRatio = mfeSum > 0 ? actual / mfeSum : 0;

  const points: MaeMfePoint[] = [];
  for (let i = 0; i < trades.length; i++) {
    const mae = maes[i] as number | null;
    const mfe = mfes[i] as number | null;
    if (mae === null || mfe === null) continue;
    points.push({ mae, mfe, pnl: profitDouble(trades[i] as Trade) });
  }

  return {
    enoughData: trades.length >= MAE_MFE_MIN_TRADES,
    points,
    avgMAE,
    avgMFE,
    mfeToMaeRatio,
    captureRatio,
    rating: maeMfeRating(mfeToMaeRatio),
    showInsight: avgMAE !== null && avgMAE > 0,
    unit: ctx.brand === "dojix" ? "pips" : "pts",
  };
}
