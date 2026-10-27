// MetricsCalculator.calculate (SPEC §3.3): the headline numbers on the Dashboard.
//
// Port of Dojix `Services/Analytics/MetricsCalculator.swift:48-142` and Greenwick's copy, which
// differs only in `netProfitAfterCosts` (Greenwick P&L is already net, DECISIONS #3) and in the
// `Int(saturating:)` flavour of the average duration.
//
// Order matters for floating-point sums: totals are summed in input order (the repository
// returns close time descending); drawdown and streaks walk a stable ascending sort by close
// time, as the Mac does.

import type { BrandId } from "../brand";
import type { CompatMode } from "../engine/compat";
import {
  commissionDouble,
  isLoss,
  isWin,
  maeRaw,
  mfeRaw,
  profitDouble,
  swapDouble,
} from "../model/accessors";
import type { Trade } from "../model/trade";
import { seqMax, seqMin, stableSorted, swiftMax } from "../swiftcompat/collections";
import { saturatingAverage } from "../swiftcompat/int";

export interface PortfolioMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  /** Percent (0–100); breakevens count in the denominator. */
  winRate: number;
  totalProfit: number;
  grossProfit: number;
  /** Positive. */
  grossLoss: number;
  /** +∞ when there are wins and no losses (shown as "99.99"); 0 with neither. */
  profitFactor: number;
  expectancy: number;
  averageWin: number;
  /** Positive. */
  averageLoss: number;
  bestTrade: number;
  worstTrade: number;
  /** Dollars below the running peak, starting from 0. */
  maxDrawdown: number;
  averageRMultiple: number;
  /** Swift compat: unknowns count as 0. Fixed (D-18): mean of known values, null when none. */
  averageMAE: number | null;
  /** See `averageMAE`. */
  averageMFE: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
  /** +wins, −losses, 0 when the last trade is a breakeven. */
  currentStreak: number;
  /** Minutes, mean truncated toward zero (saturating). */
  averageDuration: number;
  /** Per-trade mean / population σ; 0 when σ = 0; not annualised. */
  sharpeRatio: number;
  /** total / maxDD; 10 when there is no drawdown and the total is positive, else 0. */
  calmarRatio: number;
  totalCommissions: number;
  totalSwap: number;
  totalCosts: number;
  /** Dojix: total − costs (informational). Greenwick: total (already net). */
  netProfitAfterCosts: number;
}

/** `PortfolioMetrics.empty` (MetricsCalculator.swift:35-44). */
export const EMPTY_METRICS: Readonly<PortfolioMetrics> = Object.freeze({
  totalTrades: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  totalProfit: 0,
  grossProfit: 0,
  grossLoss: 0,
  profitFactor: 0,
  expectancy: 0,
  averageWin: 0,
  averageLoss: 0,
  bestTrade: 0,
  worstTrade: 0,
  maxDrawdown: 0,
  averageRMultiple: 0,
  averageMAE: 0,
  averageMFE: 0,
  maxWinStreak: 0,
  maxLossStreak: 0,
  currentStreak: 0,
  averageDuration: 0,
  sharpeRatio: 0,
  calmarRatio: 0,
  totalCommissions: 0,
  totalSwap: 0,
  totalCosts: 0,
  netProfitAfterCosts: 0,
});

export interface MetricsOptions {
  brand: BrandId;
  compat: CompatMode;
}

/** Stable ascending sort by close time (`trades.sorted { $0.closeTime < $1.closeTime }`). */
export function sortedByCloseAscending<T extends Pick<Trade, "closeTime">>(trades: readonly T[]): T[] {
  return stableSorted(trades, (a, b) => a.closeTime < b.closeTime);
}

/** Max drawdown in dollars over an ascending equity walk starting at 0 (MetricsCalculator.swift:66-74). */
export function maxDrawdownOf(ascending: readonly Trade[]): number {
  let peak = 0;
  let maxDD = 0;
  let cumulative = 0;
  for (const t of ascending) {
    cumulative += profitDouble(t);
    peak = swiftMax(peak, cumulative);
    maxDD = swiftMax(maxDD, peak - cumulative);
  }
  return maxDD;
}

export interface StreakStats {
  maxWinStreak: number;
  maxLossStreak: number;
  currentStreak: number;
}

/**
 * Streaks as MetricsCalculator counts them (MetricsCalculator.swift:77-94): a win extends the
 * win run and resets the loss run and vice versa; **a breakeven changes nothing**. StreakCard
 * counts breakevens as losses instead (PARITY D-17, kept per component).
 */
export function streaksOf(ascending: readonly Trade[]): StreakStats {
  let maxWin = 0;
  let maxLoss = 0;
  let curWin = 0;
  let curLoss = 0;
  for (const t of ascending) {
    if (isWin(t)) {
      curWin += 1;
      curLoss = 0;
      maxWin = swiftMax(maxWin, curWin);
    } else if (isLoss(t)) {
      curLoss += 1;
      curWin = 0;
      maxLoss = swiftMax(maxLoss, curLoss);
    }
  }
  let current = 0;
  const last = ascending[ascending.length - 1];
  if (last !== undefined) {
    if (isWin(last)) current = curWin;
    else if (isLoss(last)) current = -curLoss;
  }
  return { maxWinStreak: maxWin, maxLossStreak: maxLoss, currentStreak: current };
}

/** Sharpe as the Mac computes it: mean / population σ of per-trade P&L (MetricsCalculator.swift:100-103). */
export function sharpeOf(profits: readonly number[]): number {
  const n = profits.length;
  if (n === 0) return 0;
  let total = 0;
  for (const p of profits) total += p;
  const mean = total / n;
  let sq = 0;
  // Swift: pow($0 - mean, 2). Darwin's pow(x, 2) is x*x for every finite x.
  for (const p of profits) sq += (p - mean) * (p - mean);
  const sd = Math.sqrt(sq / n);
  return sd > 0 ? mean / sd : 0;
}

/** Profit factor with the Metrics sentinel (+∞ when there are no losses but some profit). */
export function profitFactorOf(grossProfit: number, grossLoss: number): number {
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
}

/** Expectancy as both apps write it: (WR/100)·avgWin − (1 − WR/100)·avgLoss. */
export function expectancyOf(winRatePercent: number, averageWin: number, averageLoss: number): number {
  return (winRatePercent / 100) * averageWin - (1 - winRatePercent / 100) * averageLoss;
}

function meanOrNull(values: readonly (number | null)[], compat: CompatMode): number | null {
  const n = values.length;
  if (compat === "swift") {
    let total = 0;
    for (const v of values) total += v ?? 0;
    return total / n;
  }
  let total = 0;
  let known = 0;
  for (const v of values) {
    if (v !== null) {
      total += v;
      known += 1;
    }
  }
  return known === 0 ? null : total / known;
}

/** `MetricsCalculator.calculate(from:)`. `trades` should be in repository order (close time descending). */
export function calculateMetrics(trades: readonly Trade[], options: MetricsOptions): PortfolioMetrics {
  const n = trades.length;
  if (n === 0) return { ...EMPTY_METRICS };

  const profits = trades.map(profitDouble);
  const winTrades = trades.filter(isWin);
  const lossTrades = trades.filter(isLoss);

  let grossProfit = 0;
  for (const t of winTrades) grossProfit += profitDouble(t);
  let lossSum = 0;
  for (const t of lossTrades) lossSum += profitDouble(t);
  const grossLoss = Math.abs(lossSum);
  let totalProfit = 0;
  for (const p of profits) totalProfit += p;

  const winRate = (winTrades.length / n) * 100;
  const profitFactor = profitFactorOf(grossProfit, grossLoss);
  const averageWin = winTrades.length === 0 ? 0 : grossProfit / winTrades.length;
  const averageLoss = lossTrades.length === 0 ? 0 : grossLoss / lossTrades.length;
  const expectancy = expectancyOf(winRate, averageWin, averageLoss);

  const ascending = sortedByCloseAscending(trades);
  const maxDrawdown = maxDrawdownOf(ascending);
  const streaks = streaksOf(ascending);

  const averageDuration = saturatingAverage(
    trades.map((t) => t.durationMin),
    options.brand === "dojix" ? "dojix" : "greenwick",
  );
  const sharpeRatio = sharpeOf(profits);
  const calmarRatio = maxDrawdown > 0 ? totalProfit / maxDrawdown : totalProfit > 0 ? 10 : 0;

  let totalCommissions = 0;
  for (const t of trades) totalCommissions += commissionDouble(t);
  let totalSwap = 0;
  for (const t of trades) totalSwap += swapDouble(t);
  const totalCosts = totalCommissions + totalSwap;

  let rSum = 0;
  for (const t of trades) rSum += t.rMultiple;

  return {
    totalTrades: n,
    wins: winTrades.length,
    losses: lossTrades.length,
    winRate,
    totalProfit,
    grossProfit,
    grossLoss,
    profitFactor,
    expectancy,
    averageWin,
    averageLoss,
    bestTrade: seqMax(profits) ?? 0,
    worstTrade: seqMin(profits) ?? 0,
    maxDrawdown,
    averageRMultiple: rSum / n,
    averageMAE: meanOrNull(trades.map(maeRaw), options.compat),
    averageMFE: meanOrNull(trades.map(mfeRaw), options.compat),
    maxWinStreak: streaks.maxWinStreak,
    maxLossStreak: streaks.maxLossStreak,
    currentStreak: streaks.currentStreak,
    averageDuration,
    sharpeRatio,
    calmarRatio,
    totalCommissions,
    totalSwap,
    totalCosts,
    netProfitAfterCosts: options.brand === "dojix" ? totalProfit - totalCosts : totalProfit,
  };
}
