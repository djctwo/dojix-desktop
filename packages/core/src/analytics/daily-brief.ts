// DailyBrief (SPEC Appendix A): the three most important signals right now.
//
// Port of Dojix `Components/DailyBrief.swift:9-11, 89-203` and Greenwick
// `Components/DailyBrief.swift` (same rules; the current session is `Date().marketSession`
// = ET session, and the best/worst group is by symbol instead of pair).
//
// - n < 5 → no signals (the card is hidden).
// - n ≥ 20: last 10 vs previous 10 by close time (a stable descending sort), summed in
//   **Decimal** and converted with `Double(truncating:)` (Foundation doubleValue):
//   hot streak (recent > 1.5 × previous and recent > 0, priority 1); otherwise a dip
//   (recent < 0 and previous > 0, priority 0). Recent WR = wins / 10 × 100.
// - Current session (from ctx.now; Dojix app buckets in UTC, Greenwick ET) with ≥ 3 trades whose
//   stored session equals it: "edge" when its Decimal P&L > 0 else "caution" (priority 2).
// - edgeByPair / edgeBySymbol: best = `max(by: profit <)` (the last of equal maxima) when > 0
//   (priority 3); worst = `min(by:)` (the first) when < 0 (priority 1). The breakdown is sorted
//   by profit, and equal-profit groups come in first-appearance order (the Mac's dictionary
//   order is random there).
// - maxDrawdown > totalProfit with totalProfit > 0 (priority 0); Sharpe ≥ 1.5 (priority 4).
// - Stable sort by priority; `signals` = the first 3.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { edgeByPair, edgeBySymbol, type EdgeBreakdown } from "../metrics/edges";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import { MARKET_SESSION_INFO, TRADING_SESSION_INFO } from "../model/enums";
import type { DojixTrade, GreenwickTrade, Trade } from "../model/trade";
import { maxBy, minBy, stableSorted } from "../swiftcompat/collections";
import { decimalSum } from "../swiftcompat/decimal";
import { asCurrency, asPercent, formatFixed } from "../swiftcompat/format";
import { fxSessionAt } from "../time/fx-sessions";
import { etSession } from "../time/us-market";
import { countWins, toRef, type ComponentParity } from "./support";

/** The signal's colour role (the Swift `Color`, not part of the parity encoding). */
export type BriefTone = "green" | "red" | "amber" | "blue";

export interface BriefSignal {
  /** SF Symbol name on the Mac; the UI maps it to its own icon. */
  icon: string;
  title: string;
  detail: string;
  value: string | null;
  tone: BriefTone;
  /** Lower = more important. */
  priority: number;
}

export interface DailyBriefModel {
  /** The top 3 (what the card shows). */
  signals: BriefSignal[];
  /** Every signal, sorted by priority (`generateSignals()`). */
  generateSignals: BriefSignal[];
}

/** `Double(truncating: Σ netProfit as NSDecimalNumber)`. */
function decimalPnL(trades: readonly Trade[]): number {
  return decimalSum(trades.map((t) => t.netProfit)).toDouble();
}

export function generateBriefSignals(ctx: EngineContext, trades: readonly Trade[], metrics: PortfolioMetrics): BriefSignal[] {
  if (trades.length < 5) return [];
  const signals: BriefSignal[] = [];

  const sorted = stableSorted(trades, (a, b) => a.closeTime > b.closeTime);
  if (sorted.length >= 20) {
    const recent10 = sorted.slice(0, 10);
    const previous10 = sorted.slice(10, 20);
    const recentPnL = decimalPnL(recent10);
    const previousPnL = decimalPnL(previous10);
    const recentWR = (countWins(recent10) / 10.0) * 100;
    if (recentPnL > previousPnL * 1.5 && recentPnL > 0) {
      signals.push({
        icon: "arrow.up.right",
        title: "Hot streak — last 10 trades trending up",
        detail: `Recent P&L ${asCurrency(recentPnL)} vs previous ${asCurrency(previousPnL)}. Win rate ${asPercent(recentWR)}.`,
        value: asCurrency(recentPnL),
        tone: "green",
        priority: 1,
      });
    } else if (recentPnL < 0 && previousPnL > 0) {
      signals.push({
        icon: "arrow.down.right",
        title: "Performance dip — last 10 trades negative",
        detail: `Recent P&L ${asCurrency(recentPnL)} vs previous ${asCurrency(previousPnL)}. Review recent entries.`,
        value: asCurrency(recentPnL),
        tone: "red",
        priority: 0,
      });
    }
  }

  // Strongest session right now
  const currentSession = ctx.brand === "greenwick" ? etSession(ctx.now) : fxSessionAt(ctx.now);
  const sessionName =
    ctx.brand === "greenwick"
      ? MARKET_SESSION_INFO[currentSession as GreenwickTrade["session"]].displayName
      : TRADING_SESSION_INFO[currentSession as DojixTrade["session"]].displayName;
  const sessionTrades = trades.filter((t) => t.session === currentSession);
  if (sessionTrades.length >= 3) {
    const sessionPnL = decimalPnL(sessionTrades);
    const sessionWR = (countWins(sessionTrades) / sessionTrades.length) * 100;
    const word = sessionPnL > 0 ? "edge" : "caution";
    signals.push({
      icon: sessionPnL > 0 ? "checkmark.circle.fill" : "exclamationmark.triangle.fill",
      title: `${sessionName} session: ${word} based on ${sessionTrades.length} trades`,
      detail: `Your ${sessionName} history: ${asPercent(sessionWR)} WR, ${asCurrency(sessionPnL)} total.`,
      value: asPercent(sessionWR),
      tone: sessionPnL > 0 ? "green" : "amber",
      priority: 2,
    });
  }

  const groups: EdgeBreakdown[] =
    ctx.brand === "greenwick" ? edgeBySymbol(trades as readonly GreenwickTrade[]) : edgeByPair(trades as readonly DojixTrade[]);
  const byProfit = (a: EdgeBreakdown, b: EdgeBreakdown) => a.profit < b.profit;
  const best = maxBy(groups, byProfit);
  if (best && best.profit > 0) {
    signals.push({
      icon: "star.fill",
      title: `${best.label} is your top performer`,
      detail: `${best.tradeCount} trades, ${asPercent(best.winRate)} win rate.`,
      value: asCurrency(best.profit),
      tone: "blue",
      priority: 3,
    });
  }
  const worst = minBy(groups, byProfit);
  if (worst && worst.profit < 0) {
    signals.push({
      icon: "xmark.circle.fill",
      title: `${worst.label} is costing you ${asCurrency(worst.profit)}`,
      detail: `${worst.tradeCount} trades at ${asPercent(worst.winRate)} WR. Consider sitting out or reducing size.`,
      value: null,
      tone: "red",
      priority: 1,
    });
  }

  if (metrics.maxDrawdown > metrics.totalProfit && metrics.totalProfit > 0) {
    signals.push({
      icon: "arrow.down.circle.fill",
      title: "Drawdown exceeds total profit",
      detail: `${asCurrency(metrics.maxDrawdown)} max DD vs ${asCurrency(metrics.totalProfit)} total P&L. Tighten stops.`,
      value: null,
      tone: "amber",
      priority: 0,
    });
  }

  if (metrics.sharpeRatio >= 1.5) {
    signals.push({
      icon: "chart.line.uptrend.xyaxis",
      title: "Excellent risk-adjusted returns",
      detail: `Sharpe ratio ${formatFixed(metrics.sharpeRatio, 2)} — your consistency is strong.`,
      value: formatFixed(metrics.sharpeRatio, 2),
      tone: "green",
      priority: 4,
    });
  }

  return stableSorted(signals, (a, b) => a.priority < b.priority);
}

/** `metrics` defaults to MetricsCalculator on the same trades (what the Dashboard passes). */
export function computeDailyBrief(ctx: EngineContext, trades: readonly Trade[], metrics?: PortfolioMetrics): DailyBriefModel {
  const all = generateBriefSignals(ctx, trades, metrics ?? calculateMetrics(trades, ctx));
  return { signals: all.slice(0, 3), generateSignals: all };
}

export const dailyBriefComponent = defineComponent<BrandId, DailyBriefModel>({
  id: "DailyBrief",
  brands: ["dojix", "greenwick"],
  tab: "overview",
  minTrades: 5,
  compute: (ctx, trades) => {
    const m = computeDailyBrief(ctx, trades);
    return m.signals.length === 0 ? null : m;
  },
});

const encodeSignals = (signals: readonly BriefSignal[]) => toRef(signals, { omit: ["tone"] });

export const dailyBriefParity: ComponentParity<DailyBriefModel> = {
  component: "DailyBrief",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades, instance) => (instance === undefined ? computeDailyBrief(ctx, trades) : undefined),
  members: {
    signals: (m) => encodeSignals(m.signals),
    generateSignals: (m) => encodeSignals(m.generateSignals),
  },
};
