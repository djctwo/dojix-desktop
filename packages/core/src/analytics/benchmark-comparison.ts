// BenchmarkComparison (SPEC Appendix A): the trader's headline numbers against fixed retail
// benchmarks.
//
// Port of Dojix `Components/BenchmarkComparison.swift:18-99` and Greenwick
// `Components/BenchmarkComparison.swift:18-99` (identical). Needs totalTrades ≥ 10.
// Benchmarks: WR 45 ("%.1f%%"), PF 1.3 ("%.2f"), avg R 0.3 ("%.2fR"), Sharpe 0.5 ("%.2f"),
// DD% = maxDD / max(|total|, 1) × 100 vs 30 ("%.0f%%", lower is better).
// Status band: ±10% of the benchmark (strict inequalities). A profit factor of +∞ prints
// "inf" (printf) and is "above".

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import type { ComponentParity } from "./support";

export type BenchmarkStatus = "above" | "at" | "below";

/** `Status.icon` (BenchmarkComparison.swift:71-77). */
export const BENCHMARK_STATUS_ICON: Readonly<Record<BenchmarkStatus, string>> = {
  above: "chevron.up.circle.fill",
  at: "minus.circle",
  below: "chevron.down.circle.fill",
};

export interface BenchmarkRow {
  metric: string;
  yours: string;
  benchmark: string;
  status: BenchmarkStatus;
}

export interface BenchmarkComparisonModel {
  comparisons: BenchmarkRow[];
  /** "Above average in a/b metrics". */
  aboveCount: number;
}

export interface BenchmarkComparisonOptions {
  /** The Dashboard's metrics for these trades (computed here when omitted). */
  metrics?: PortfolioMetrics;
}

function row(
  metric: string,
  yours: number,
  benchmark: number,
  format: string,
  betterWhen: "higher" | "lower",
): BenchmarkRow {
  const threshold = benchmark * 0.1;
  const diff = yours - benchmark;
  let status: BenchmarkStatus;
  if (betterWhen === "higher") status = diff > threshold ? "above" : diff < -threshold ? "below" : "at";
  else status = diff < -threshold ? "above" : diff > threshold ? "below" : "at";
  return { metric, yours: swiftFormat(format, yours), benchmark: swiftFormat(format, benchmark), status };
}

export function computeBenchmarkComparison(
  ctx: EngineContext,
  trades: readonly Trade[],
  options: BenchmarkComparisonOptions = {},
): BenchmarkComparisonModel {
  const m = options.metrics ?? calculateMetrics(trades, ctx);
  if (m.totalTrades < 10) return { comparisons: [], aboveCount: 0 };
  const comparisons = [
    row("Win Rate", m.winRate, 45, "%.1f%%", "higher"),
    row("Profit Factor", m.profitFactor, 1.3, "%.2f", "higher"),
    row("Avg R-Multiple", m.averageRMultiple, 0.3, "%.2fR", "higher"),
    row("Sharpe Ratio", m.sharpeRatio, 0.5, "%.2f", "higher"),
    row("Max Drawdown %", (m.maxDrawdown / swiftMax(Math.abs(m.totalProfit), 1)) * 100, 30, "%.0f%%", "lower"),
  ];
  return { comparisons, aboveCount: comparisons.filter((c) => c.status === "above").length };
}

export const benchmarkComparisonComponent = defineComponent<BrandId, BenchmarkComparisonModel>({
  id: "BenchmarkComparison",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  minTrades: 10,
  compute: (ctx, trades) => computeBenchmarkComparison(ctx, trades),
});

export const benchmarkComparisonParity: ComponentParity<BenchmarkComparisonModel> = {
  component: "BenchmarkComparison",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeBenchmarkComparison(ctx, trades),
  members: {
    // Labelled tuple → object; Status has no raw value and exposes `icon` (RefDumpable).
    comparisons: (m) =>
      m.comparisons.map((c) => ({
        benchmark: c.benchmark,
        metric: c.metric,
        status: { $case: c.status, icon: BENCHMARK_STATUS_ICON[c.status] },
        yours: c.yours,
      })),
  },
};
