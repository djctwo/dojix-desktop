// OpeningRangeAnalysis (Greenwick `Components/OpeningRangeAnalysis.swift`): performance by
// minutes after the 09:30 ET open, for trades opened in the regular session (09:30–16:00 ET
// wall clock of the open; weekends are not excluded, as on the Mac).

import type { GreenwickTrade } from "../../model/trade";
import { maxBy, minBy } from "../../swiftcompat/collections";
import { asCurrency } from "../../swiftcompat/format";
import { TRADING_CALENDAR, US_MARKET } from "../../time/us-market";
import { sumProfit, winCount } from "./shared";

export type OpeningRangeBucketId = "5min" | "15min" | "30min" | "midmorn" | "lunch" | "afternoon" | "power";

export interface OpeningRangeBucket {
  id: OpeningRangeBucketId;
  label: string;
  tradeCount: number;
  /** Percent. */
  winRate: number;
  avgPnL: number;
  totalPnL: number;
}

export interface OpeningRangeModel {
  /** All seven buckets in display order. */
  buckets: OpeningRangeBucket[];
  /** Buckets with at least one trade. */
  activeBuckets: OpeningRangeBucket[];
  /** Some bucket has trades (else "No regular session trades to analyze"). */
  hasData: boolean;
  /** Highest average P&L (first of ties). Highlighted only when more than one bucket is active. */
  bestBucket: OpeningRangeBucket | null;
  /** Lowest average P&L (first of ties). Highlighted only when more than one bucket is active and its average is negative. */
  worstBucket: OpeningRangeBucket | null;
  insightText: string;
}

/** OpeningRangeAnalysis.swift:39-47: [start, end) minutes after 09:30. */
export const OPENING_RANGE_BUCKETS: readonly { id: OpeningRangeBucketId; label: string; startMin: number; endMin: number }[] = [
  { id: "5min", label: "First 5 min", startMin: 0, endMin: 5 },
  { id: "15min", label: "First 15 min", startMin: 5, endMin: 15 },
  { id: "30min", label: "First 30 min", startMin: 15, endMin: 30 },
  { id: "midmorn", label: "Mid-Morning", startMin: 30, endMin: 120 },
  { id: "lunch", label: "Lunch", startMin: 120, endMin: 210 },
  { id: "afternoon", label: "Afternoon", startMin: 210, endMin: 330 },
  { id: "power", label: "Power Hour", startMin: 330, endMin: 390 },
];

/** `minutesSinceOpen` (:22-30): minutes after 09:30 ET of the open, null outside 09:30–16:00. */
export function minutesSinceOpen(t: Pick<GreenwickTrade, "openTime">): number | null {
  const total = TRADING_CALENDAR.minuteOfDay(t.openTime);
  if (total < US_MARKET.regularOpen || total >= US_MARKET.regularClose) return null;
  return total - US_MARKET.regularOpen;
}

/** OpeningRangeAnalysis.swift:49-102. No minimum trade count. */
export function computeOpeningRange(trades: readonly GreenwickTrade[], locale: string): OpeningRangeModel {
  const minutes = trades.map(minutesSinceOpen);
  const buckets = OPENING_RANGE_BUCKETS.map(({ id, label, startMin, endMin }): OpeningRangeBucket => {
    const matching = trades.filter((_, i) => {
      const m = minutes[i];
      return m !== null && m !== undefined && m >= startMin && m < endMin;
    });
    const totalPnL = sumProfit(matching);
    return {
      id,
      label,
      tradeCount: matching.length,
      winRate: matching.length === 0 ? 0 : (winCount(matching) / matching.length) * 100,
      avgPnL: matching.length === 0 ? 0 : totalPnL / matching.length,
      totalPnL,
    };
  });
  const activeBuckets = buckets.filter((b) => b.tradeCount > 0);
  const best = maxBy(activeBuckets, (a, b) => a.avgPnL < b.avgPnL) ?? null;
  const worst = minBy(activeBuckets, (a, b) => a.avgPnL < b.avgPnL) ?? null;

  // insightText (:88-102)
  let insightText: string;
  if (best === null || worst === null || best.id === worst.id) {
    insightText = "Need more trades across different times for insights";
  } else {
    const bestAvg = best.avgPnL >= 0 ? `+${asCurrency(best.avgPnL, locale)}` : asCurrency(best.avgPnL, locale);
    if (worst.totalPnL < 0) {
      insightText = `Your best entries are ${best.label.toLowerCase()} (${bestAvg} avg) — ${worst.label.toLowerCase()} costs you ${asCurrency(Math.abs(worst.totalPnL), locale)}`;
    } else {
      insightText = `Your best entries are ${best.label.toLowerCase()} (${bestAvg} avg)`;
    }
  }

  return { buckets, activeBuckets, hasData: activeBuckets.length > 0, bestBucket: best, worstBucket: worst, insightText };
}
