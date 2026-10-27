// EmotionalAnalytics, the "Tiltmeter" (SPEC Appendix A).
//
// Port of Dojix `Components/EmotionalAnalytics.swift:10-39` and Greenwick
// `Components/EmotionalAnalytics.swift:10-39` (identical computation). Trades with a known
// emotion; at least 10 of them, else `metrics` is nil. Per emotion: count, wins, Σ P&L, win
// rate as a **fraction**, average P&L; sorted by average descending. The view needs ≥ 2
// emotions (line 47).
//
// Trap: the Mac groups with a Dictionary, so emotions with equal averages come out in random
// order; the desktop keeps first-appearance order for ties (stable sort).

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { isWin, profitDouble, tradeEmotion } from "../model/accessors";
import { TRADE_EMOTIONS, type TradeEmotion } from "../model/enums";
import type { Trade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import { type ComponentParity } from "./support";

export interface EmotionMetric {
  emotion: TradeEmotion;
  displayName: string;
  count: number;
  wins: number;
  totalPnL: number;
  /** Fraction 0–1. */
  winRate: number;
  avgPnL: number;
}

export interface EmotionalAnalyticsModel {
  /** null with fewer than 10 emotion-tagged trades. */
  metrics: EmotionMetric[] | null;
  /** Emotion-tagged trades. */
  taggedCount: number;
}

export function computeEmotionalAnalytics(trades: readonly Trade[]): EmotionalAnalyticsModel {
  const groups = new Map<TradeEmotion, { count: number; wins: number; pnl: number }>();
  let tagged = 0;
  for (const t of trades) {
    const e = tradeEmotion(t);
    if (e === null) continue;
    tagged += 1;
    const g = groups.get(e) ?? { count: 0, wins: 0, pnl: 0 };
    g.count += 1;
    if (isWin(t)) g.wins += 1;
    g.pnl += profitDouble(t);
    groups.set(e, g);
  }
  if (tagged < 10) return { metrics: null, taggedCount: tagged };
  const rows: EmotionMetric[] = [...groups].map(([emotion, g]) => ({
    emotion,
    displayName: TRADE_EMOTIONS[emotion],
    count: g.count,
    wins: g.wins,
    totalPnL: g.pnl,
    winRate: g.count > 0 ? g.wins / g.count : 0,
    avgPnL: g.count > 0 ? g.pnl / g.count : 0,
  }));
  return { metrics: stableSorted(rows, (a, b) => a.avgPnL > b.avgPnL), taggedCount: tagged };
}

export const emotionalAnalyticsComponent = defineComponent<BrandId, EmotionMetric[]>({
  id: "EmotionalAnalytics",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 10,
  compute: (_ctx, trades) => {
    const m = computeEmotionalAnalytics(trades).metrics;
    return m !== null && m.length > 1 ? m : null;
  },
});

export const emotionalAnalyticsParity: ComponentParity<EmotionalAnalyticsModel> = {
  component: "EmotionalAnalytics",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computeEmotionalAnalytics(trades),
  members: {
    // EmotionMetric: id + emotion (raw values), count, wins, totalPnL, + winRate, avgPnL.
    metrics: (m) =>
      m.metrics === null
        ? null
        : m.metrics.map((r) => ({
            id: r.emotion,
            emotion: r.emotion,
            count: r.count,
            wins: r.wins,
            totalPnL: r.totalPnL,
            winRate: r.winRate,
            avgPnL: r.avgPnL,
          })),
  },
};
