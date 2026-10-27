// WinLossDistribution (Pairs / Symbols tab, both brands). SPEC Appendix A "WinLossDistribution".
//
// Dojix `Components/WinLossDistribution.swift:16-40,77-85`; Greenwick's copy is identical.
//
// - maxAbs = max(max p, |min p|); no buckets when maxAbs ≤ 0 (or NaN);
// - bucket size bs = maxAbs / 5; buckets i = −5 … 4 cover [i·bs, (i+1)·bs); empty ones omitted;
// - label `Int(saturating: low)` printed as an Int; isProfit = low ≥ 0;
// - median of all P&Ls (mean of the two middle values when the count is even).
//
// PARITY D-01 (`fixed`): on the Mac a P&L equal to +maxAbs falls outside every bucket (the top
// bucket is half-open at 5·bs), so the largest win is missing from the chart. The desktop
// closes the top bucket at +maxAbs and starts the bottom one at −maxAbs, so every P&L is
// counted exactly once (5·bs and −5·bs can also miss ±maxAbs by one rounding step).

import type { EngineContext } from "../engine/context";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { seqMax, seqMin, swiftMax } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import { intSaturating } from "../swiftcompat/int";
import { swiftMedian } from "./shared";

export interface DistributionBucket {
  range: string;
  count: number;
  isProfit: boolean;
  /** Lower and upper edge of the bucket. */
  low: number;
  high: number;
}

export interface WinLossDistributionModel {
  /** Empty shows "Not enough data". */
  buckets: DistributionBucket[];
  /** Median P&L, null without trades. */
  median: number | null;
  maxAbs: number;
  bucketSize: number;
}

export function winLossDistribution(ctx: EngineContext, trades: readonly Trade[]): WinLossDistributionModel {
  const profits = trades.map(profitDouble);
  const median = swiftMedian(profits);
  if (profits.length === 0) return { buckets: [], median, maxAbs: 0, bucketSize: 0 };
  const maxProfit = seqMax(profits) ?? 0;
  const maxLoss = Math.abs(seqMin(profits) ?? 0);
  const maxAbs = swiftMax(maxProfit, maxLoss);
  if (!(maxAbs > 0)) return { buckets: [], median, maxAbs, bucketSize: 0 };
  const bucketSize = maxAbs / 5;
  const fixed = ctx.compat === "fixed";
  const flavor = ctx.brand === "dojix" ? "dojix" : "greenwick";
  const buckets: DistributionBucket[] = [];
  for (let i = -5; i < 5; i++) {
    const macLow = i * bucketSize;
    const low = fixed && i === -5 ? -maxAbs : macLow;
    const high = (i + 1) * bucketSize;
    const top = fixed && i === 4;
    const count = profits.filter((p) => p >= low && (top ? p <= maxAbs : p < high)).length;
    if (count === 0) continue;
    buckets.push({
      // The label stays the Mac's (the lower edge i·bs) in both modes.
      range: swiftFormat("%d", intSaturating(macLow, flavor)),
      count,
      isProfit: macLow >= 0,
      low,
      high: top ? maxAbs : high,
    });
  }
  return { buckets, median, maxAbs, bucketSize };
}
