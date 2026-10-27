// RegimeAnalysis (Greenwick `Components/RegimeAnalysis.swift`): classifies each ET trading day
// (the ET date of the close) as Trending, Choppy, Volatile or Calm, and compares performance.
//
// Classification (:122-137), first match wins:
// - Trending: win rate > 60%, avgLoser > 0 and avgWinner > 1.5 × avgLoser;
// - Choppy: win rate < 40%;
// - Volatile: median day MAE > 0 and the day's average MAE > 2 × that median;
// - Calm otherwise.
//
// D-18: the Mac averages MAE over every trade, unknown MAE counted as 0 (`compat: "swift"`).
// In `fixed` mode a day's average MAE uses only trades with a known MAE; a day without any is
// left out of the median and can't be Volatile.
//
// Determinism: the "current regime" is the most common regime of the last five days. The Mac
// takes `max(by:)` over a dictionary, so a tie is random. The desktop counts in the order the
// regimes first appear in those days and keeps Swift's `max(by:)` rule (the last of equal
// counts wins), i.e. the tied regime that showed up most recently first (F8 tie trap).

import type { CompatMode } from "../../engine/compat";
import { isLoss, isWin, maeOf } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";
import { maxBy, minBy, seqMax } from "../../swiftcompat/collections";
import { asCurrency } from "../../swiftcompat/format";
import { TRADING_CALENDAR } from "../../time/us-market";
import { sumProfit } from "./shared";

export type Regime = "Trending" | "Choppy" | "Volatile" | "Calm";

/** `Regime.allCases` (declaration order: the table order). */
export const REGIMES: readonly Regime[] = ["Trending", "Choppy", "Volatile", "Calm"];

/** `Regime.icon` (SF Symbol names; the desktop maps them to its own icons). */
export const REGIME_ICONS: Readonly<Record<Regime, string>> = {
  Trending: "arrow.up.right",
  Choppy: "waveform",
  Volatile: "bolt.fill",
  Calm: "leaf.fill",
};

export interface RegimeDay {
  /** "2026-03-09" (ET date of the close). */
  dayKey: string;
  /** New York midnight of that day, epoch ms. */
  date: number;
  trades: GreenwickTrade[];
  /** Percent. */
  winRate: number;
  avgPnL: number;
  totalPnL: number;
  /** Null only in `fixed` mode, when no trade of the day has a known MAE. */
  avgMAE: number | null;
  avgWinner: number;
  /** Absolute value. */
  avgLoser: number;
  regime: Regime;
}

export interface RegimeStats {
  regime: Regime;
  dayCount: number;
  /** Percent, over the trades of those days. */
  winRate: number;
  /** Average P&L per day. */
  avgPnL: number;
  totalPnL: number;
}

export interface RegimeAnalysisModel {
  medianDayMAE: number;
  /** One entry per trading day, oldest first. */
  tradingDays: RegimeDay[];
  /** Regimes that occur, in `REGIMES` order. */
  regimeStats: RegimeStats[];
  /** Highest average P&L per day (last of ties). */
  bestRegime: RegimeStats | null;
  /** Lowest total P&L (first of ties). */
  worstRegime: RegimeStats | null;
  /** Most common regime of the last 5 trading days. */
  currentRegime: Regime | null;
  /** Longest bar (chart scale). */
  maxRegimeDays: number;
  /** "You thrive in … days" when the best regime's average is positive. */
  bestInsight: string | null;
  /** "Consider sitting out … days" when the worst regime's total is negative. */
  worstInsight: string | null;
  /** True when only one regime occurs ("More trading days needed to detect varied market regimes"). */
  needsMoreVariety: boolean;
}

/** `classifyRegime` (:122-137). An unknown day MAE (fixed mode) is never Volatile. */
export function classifyRegime(winRate: number, avgWinner: number, avgLoser: number, avgMAE: number | null, medianMAE: number): Regime {
  if (winRate > 60 && avgLoser > 0 && avgWinner > 1.5 * avgLoser) return "Trending";
  if (winRate < 40) return "Choppy";
  if (avgMAE !== null && medianMAE > 0 && avgMAE > 2 * medianMAE) return "Volatile";
  return "Calm";
}

/** A day's average MAE: every trade in `swift` mode (unknown = 0), known ones only in `fixed` (D-18). */
function dayAvgMAE(trades: readonly GreenwickTrade[], compat: CompatMode): number | null {
  let total = 0;
  let n = 0;
  for (const t of trades) {
    const m = maeOf(t, compat);
    if (m === null) continue;
    total += m;
    n += 1;
  }
  return n === 0 ? null : total / n;
}

/** `medianDayMAE` (:63-76). */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

function avgProfit(trades: readonly GreenwickTrade[]): number {
  return trades.length === 0 ? 0 : sumProfit(trades) / trades.length;
}

/**
 * RegimeAnalysis.swift:63-185. The card needs 10 trades (the registry guard) and 3 trading
 * days ("Need at least 3 trading days for regime classification").
 */
export function computeRegimeAnalysis(trades: readonly GreenwickTrade[], compat: CompatMode): RegimeAnalysisModel {
  const byDay = new Map<string, GreenwickTrade[]>();
  for (const t of trades) {
    const k = TRADING_CALENDAR.dayKey(t.closeTime);
    const g = byDay.get(k);
    if (g) g.push(t);
    else byDay.set(k, [t]);
  }

  const dayMAEs = new Map<string, number | null>();
  for (const [k, ts] of byDay) dayMAEs.set(k, dayAvgMAE(ts, compat));
  const medianDayMAE = medianOf([...dayMAEs.values()].filter((v): v is number => v !== null));

  const tradingDays = [...byDay]
    .map(([dayKey, dayTrades]): RegimeDay => {
      const winners = dayTrades.filter(isWin);
      const losers = dayTrades.filter(isLoss);
      const winRate = (winners.length / dayTrades.length) * 100;
      const totalPnL = sumProfit(dayTrades);
      const avgMAE = dayMAEs.get(dayKey) ?? null;
      const avgWinner = avgProfit(winners);
      const avgLoser = Math.abs(avgProfit(losers));
      return {
        dayKey,
        date: TRADING_CALENDAR.startOfDay((dayTrades[0] as GreenwickTrade).closeTime),
        trades: dayTrades,
        winRate,
        avgPnL: totalPnL / dayTrades.length,
        totalPnL,
        avgMAE,
        avgWinner,
        avgLoser,
        regime: classifyRegime(winRate, avgWinner, avgLoser, avgMAE, medianDayMAE),
      };
    })
    .sort((a, b) => a.date - b.date);

  // regimeStats (:139-159)
  const regimeStats: RegimeStats[] = [];
  for (const regime of REGIMES) {
    const days = tradingDays.filter((d) => d.regime === regime);
    if (days.length === 0) continue;
    let tradeCount = 0;
    let wins = 0;
    let totalPnL = 0;
    for (const d of days) {
      tradeCount += d.trades.length;
      for (const t of d.trades) if (isWin(t)) wins += 1;
      totalPnL += d.totalPnL;
    }
    regimeStats.push({
      regime,
      dayCount: days.length,
      winRate: tradeCount === 0 ? 0 : (wins / tradeCount) * 100,
      avgPnL: totalPnL / days.length,
      totalPnL,
    });
  }

  const bestRegime = maxBy(regimeStats, (a, b) => a.avgPnL < b.avgPnL) ?? null;
  const worstRegime = minBy(regimeStats, (a, b) => a.totalPnL < b.totalPnL) ?? null;

  // currentRegime (:169-179)
  const counts = new Map<Regime, number>();
  for (const d of tradingDays.slice(-5)) counts.set(d.regime, (counts.get(d.regime) ?? 0) + 1);
  const currentRegime = maxBy(counts, (a, b) => a[1] < b[1])?.[0] ?? null;

  return {
    medianDayMAE,
    tradingDays,
    regimeStats,
    bestRegime,
    worstRegime,
    currentRegime,
    maxRegimeDays: seqMax(regimeStats.map((s) => s.dayCount)) ?? 1,
    // regimeInsights (:377-404)
    bestInsight:
      bestRegime && bestRegime.avgPnL > 0
        ? `You thrive in ${bestRegime.regime} days -- avg ${asCurrency(bestRegime.avgPnL)}/day across ${bestRegime.dayCount} days`
        : null,
    worstInsight:
      worstRegime && worstRegime.totalPnL < 0
        ? `Consider sitting out ${worstRegime.regime} days -- costs you ${asCurrency(Math.abs(worstRegime.totalPnL))} total`
        : null,
    needsMoreVariety: regimeStats.length <= 1,
  };
}

