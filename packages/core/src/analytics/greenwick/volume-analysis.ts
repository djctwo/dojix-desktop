// VolumeAnalysis (Greenwick `Components/VolumeAnalysis.swift`): performance by relative volume
// (RVOL = volume / average volume) in four buckets, and high- vs low-RVOL average P&L.
//
// Parity notes:
// - The buckets are Swift `ClosedRange`s that share their edges (0…0.5, 0.5…1.5, 1.5…3,
//   3…1000), so an RVOL of exactly 0.5, 1.5 or 3 counts in two buckets, and an RVOL above 1000
//   in none. No PARITY entry changes this.
// - The insight compares RVOL > 1.5 with RVOL < 0.5 (strict), unlike the buckets.

import { profitDouble } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";
import { asCurrency } from "../../swiftcompat/format";
import { sumProfit, winCount } from "./shared";

export type VolumeBucketId = "low" | "normal" | "high" | "vhigh";

export interface VolumeBucket {
  id: VolumeBucketId;
  label: string;
  tradeCount: number;
  avgPnL: number;
  /** Percent. */
  winRate: number;
  totalPnL: number;
}

export interface VolumeAnalysisModel {
  /** Some trade has volume data (else "Import volume data for analysis"). */
  hasVolumeData: boolean;
  /** Trades with volume > 0 and average volume > 0, in input order. */
  tradesWithVolume: GreenwickTrade[];
  /** All four buckets in display order (the detail rows show only those with trades). */
  buckets: VolumeBucket[];
  highVolumeCount: number;
  highVolumeAvgPnL: number;
  lowVolumeCount: number;
  lowVolumeAvgPnL: number;
  insightText: string;
}

/** VolumeAnalysis.swift:33-38. */
export const VOLUME_BUCKET_RANGES: readonly { id: VolumeBucketId; label: string; lo: number; hi: number }[] = [
  { id: "low", label: "Low (<0.5x)", lo: 0, hi: 0.5 },
  { id: "normal", label: "Normal (0.5-1.5x)", lo: 0.5, hi: 1.5 },
  { id: "high", label: "High (1.5-3x)", lo: 1.5, hi: 3.0 },
  { id: "vhigh", label: "Very High (>3x)", lo: 3.0, hi: 1000.0 },
];

/** `relativeVolume(for:)` (:27-30): `Double(volume) / Double(avgVolume)`, 0 without an average. */
export function relativeVolume(t: Pick<GreenwickTrade, "volume" | "avgVolume">): number {
  if (!(t.avgVolume > 0)) return 0;
  return t.volume / t.avgVolume;
}

function avgPnL(trades: readonly GreenwickTrade[]): number {
  if (trades.length === 0) return 0;
  let total = 0;
  for (const t of trades) total += profitDouble(t);
  return total / trades.length;
}

function signedCurrency(x: number, locale: string): string {
  return x >= 0 ? `+${asCurrency(x, locale)}` : asCurrency(x, locale);
}

/** VolumeAnalysis.swift:19-72. No minimum trade count. */
export function computeVolumeAnalysis(trades: readonly GreenwickTrade[], locale: string): VolumeAnalysisModel {
  const tradesWithVolume = trades.filter((t) => t.volume > 0 && t.avgVolume > 0);

  const buckets = VOLUME_BUCKET_RANGES.map(({ id, label, lo, hi }): VolumeBucket => {
    const matching = tradesWithVolume.filter((t) => {
      const rv = relativeVolume(t);
      return lo <= rv && rv <= hi;
    });
    return {
      id,
      label,
      tradeCount: matching.length,
      avgPnL: avgPnL(matching),
      winRate: matching.length === 0 ? 0 : (winCount(matching) / matching.length) * 100,
      totalPnL: sumProfit(matching),
    };
  });

  const high = tradesWithVolume.filter((t) => relativeVolume(t) > 1.5);
  const low = tradesWithVolume.filter((t) => relativeVolume(t) < 0.5);
  const highAvg = avgPnL(high);
  const lowAvg = avgPnL(low);
  const insightText =
    high.length === 0 && low.length === 0
      ? "Most trades occur at normal relative volume"
      : `Trades on high relative volume days average ${signedCurrency(highAvg, locale)} vs ${signedCurrency(lowAvg, locale)} on low volume`;

  return {
    hasVolumeData: tradesWithVolume.length > 0,
    tradesWithVolume,
    buckets,
    highVolumeCount: high.length,
    highVolumeAvgPnL: highAvg,
    lowVolumeCount: low.length,
    lowVolumeAvgPnL: lowAvg,
    insightText,
  };
}
