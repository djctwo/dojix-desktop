// StrategyCheckpoints (SPEC Appendix A): before/after metrics around each strategy change the
// user marks.
//
// Port of Dojix `Components/StrategyCheckpoints.swift:14-38,96-101,139-155` and Greenwick
// `Components/StrategyCheckpoints.swift` (identical computation):
// - before = close < checkpoint date, after = close ≥ date; each side sorted ASC (stable) and
//   then run through `MetricsCalculator.calculate`, so its sums run in **ascending** order;
// - `metrics(for:)` keeps tradeCount, winRate (%), profitFactor, expectancy, avgR, maxDrawdown,
//   sharpe, and is all zeros for an empty side;
// - the two sides are compared only when both have ≥ 5 trades (ConfidenceBadge on the smaller).
//
// The checkpoints themselves live in the journal (`strategy_checkpoints`); the registry entry
// has none and shows the Mac's "No checkpoints yet" state (null). The UI calls
// `computeStrategyCheckpoints` with the journal's checkpoints.
//
// Tier B key "StrategyCheckpoints.split" (tools/swift-ref `refCheckpointSplit`): one fictional
// checkpoint at the median close time (`sorted closes[count / 2]`, epoch 0 when empty).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { calculateMetrics, sortedByCloseAscending } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import { swiftMin } from "../swiftcompat/collections";
import { refDate, type ComponentParity } from "./support";

export interface StrategyCheckpoint {
  /** Journal row id (null before insert). */
  id: number | null;
  /** Epoch ms. */
  date: number;
  title: string;
  description: string;
}

/** `StrategyCheckpoints.ComparisonMetrics`. */
export interface ComparisonMetrics {
  tradeCount: number;
  /** Percent. */
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgR: number;
  maxDrawdown: number;
  sharpe: number;
}

export interface CheckpointComparison<T extends Trade = Trade> {
  checkpoint: StrategyCheckpoint;
  /** Close < date, ascending. */
  beforeTrades: T[];
  /** Close ≥ date, ascending. */
  afterTrades: T[];
  before: ComparisonMetrics;
  after: ComparisonMetrics;
  /** Both sides have ≥ 5 trades. */
  comparable: boolean;
  /** min(before, after) trade count (the ConfidenceBadge sample size). */
  confidenceSampleSize: number;
}

export interface StrategyCheckpointsModel<T extends Trade = Trade> {
  checkpoints: CheckpointComparison<T>[];
}

const ZERO: Readonly<ComparisonMetrics> = Object.freeze({
  tradeCount: 0,
  winRate: 0,
  profitFactor: 0,
  expectancy: 0,
  avgR: 0,
  maxDrawdown: 0,
  sharpe: 0,
});

/** `StrategyCheckpoints.metrics(for:)` (StrategyCheckpoints.swift:24-38). */
export function checkpointMetrics(ctx: EngineContext, filtered: readonly Trade[]): ComparisonMetrics {
  if (filtered.length === 0) return { ...ZERO };
  const m = calculateMetrics(filtered, ctx);
  return {
    tradeCount: m.totalTrades,
    winRate: m.winRate,
    profitFactor: m.profitFactor,
    expectancy: m.expectancy,
    avgR: m.averageRMultiple,
    maxDrawdown: m.maxDrawdown,
    sharpe: m.sharpeRatio,
  };
}

export function compareAtCheckpoint<T extends Trade>(
  ctx: EngineContext,
  trades: readonly T[],
  checkpoint: StrategyCheckpoint,
): CheckpointComparison<T> {
  const beforeTrades = sortedByCloseAscending(trades.filter((t) => t.closeTime < checkpoint.date));
  const afterTrades = sortedByCloseAscending(trades.filter((t) => t.closeTime >= checkpoint.date));
  const before = checkpointMetrics(ctx, beforeTrades);
  const after = checkpointMetrics(ctx, afterTrades);
  return {
    checkpoint,
    beforeTrades,
    afterTrades,
    before,
    after,
    comparable: before.tradeCount >= 5 && after.tradeCount >= 5,
    confidenceSampleSize: swiftMin(before.tradeCount, after.tradeCount),
  };
}

export function computeStrategyCheckpoints<T extends Trade>(
  ctx: EngineContext,
  trades: readonly T[],
  checkpoints: readonly StrategyCheckpoint[] = [],
): StrategyCheckpointsModel<T> {
  return { checkpoints: checkpoints.map((cp) => compareAtCheckpoint(ctx, trades, cp)) };
}

/** The harness's fixture checkpoint: the median close time (epoch 0 without trades). */
export function fixtureCheckpoint(trades: readonly Trade[]): StrategyCheckpoint {
  const closes = trades.map((t) => t.closeTime).sort((a, b) => a - b);
  const middle = closes.length === 0 ? 0 : (closes[Math.floor(closes.length / 2)] as number);
  return { id: null, date: middle, title: "Fixture checkpoint", description: "fictional" };
}

export const strategyCheckpointsComponent = defineComponent<BrandId, StrategyCheckpointsModel>({
  id: "StrategyCheckpoints",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  minTrades: 0,
  // No checkpoints in the registry call: the Mac's "No checkpoints yet" state.
  compute: () => null,
});

export const strategyCheckpointsParity: ComponentParity<StrategyCheckpointsModel> = {
  component: "StrategyCheckpoints",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeStrategyCheckpoints(ctx, trades, [fixtureCheckpoint(trades)]),
  members: {
    // refCheckpointSplit: [String: Any] per checkpoint; ComparisonMetrics is a plain struct.
    split: (m) =>
      m.checkpoints.map((c) => ({
        after: { ...c.after },
        afterCount: c.afterTrades.length,
        before: { ...c.before },
        beforeCount: c.beforeTrades.length,
        date: refDate(c.checkpoint.date),
      })),
  },
};
