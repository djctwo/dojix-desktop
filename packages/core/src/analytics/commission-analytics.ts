// CommissionAnalytics (SPEC Appendix A): the drag of commissions and swap / fees.
//
// Port of Dojix `Components/CommissionAnalytics.swift:10-46, 151-163, 182-191` and Greenwick
// `Components/CommissionAnalytics.swift:10-47, 152-164, 183-192`.
//
// - Shown only when some trade has `totalCosts != 0` (Double commission + swap).
// - Totals summed in input order; avg/trade = total / n (0 when empty).
// - grossProfit: Dojix Σ profitDouble of trades with profitDouble > 0 (a Double compare, not
//   `isWin`); Greenwick Σ of (net + costs) where that gross is > 0 (Greenwick P&L is net).
// - costPercent = |costs| / grossProfit × 100 (0 when grossProfit ≤ 0); < 5 green, < 15 yellow,
//   else red.
// - Per symbol: Σ costs and Σ lots (Dojix) / shares (Greenwick); cost per lot / share =
//   |costs| / size (0 when size ≤ 0); sorted by |costs| descending (stable; equal groups in
//   first-appearance order — the Mac's dictionary order is random). The view shows the top 5
//   and the chart when there are 2+ symbols.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { commissionDouble, profitDouble, swapDouble, totalCosts as tradeCosts } from "../model/accessors";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, stableSorted } from "../swiftcompat/collections";
import { formatFixed } from "../swiftcompat/format";
import { type ComponentParity } from "./support";

export interface SymbolCost {
  symbol: string;
  totalCosts: number;
  /** Lots (Dojix) or shares (Greenwick). */
  totalSize: number;
  /** |costs| / size, 0 when the size is not positive (`costPerLot` / `costPerShare`). */
  costPerUnit: number;
}

export type CostLevel = "green" | "yellow" | "red";

export interface CommissionAnalyticsModel {
  hasCostData: boolean;
  totalCommissions: number;
  totalSwap: number;
  totalCosts: number;
  avgCostPerTrade: number;
  grossProfit: number;
  costPercent: number;
  symbolCosts: SymbolCost[];
  /** Banner colour (`insightBanner`). */
  costLevel: CostLevel;
  /** "Costs consume 12.3% of gross profit". */
  insightText: string;
}

export function computeCommissionAnalytics(ctx: EngineContext, trades: readonly Trade[]): CommissionAnalyticsModel {
  const hasCostData = trades.some((t) => tradeCosts(t) !== 0);
  let totalCommissions = 0;
  for (const t of trades) totalCommissions += commissionDouble(t);
  let totalSwap = 0;
  for (const t of trades) totalSwap += swapDouble(t);
  const totalCosts = totalCommissions + totalSwap;
  const avgCostPerTrade = trades.length === 0 ? 0 : totalCosts / trades.length;

  let grossProfit = 0;
  if (ctx.brand === "greenwick") {
    for (const t of trades) {
      const gross = profitDouble(t) + tradeCosts(t);
      if (gross > 0) grossProfit += gross;
    }
  } else {
    for (const t of trades) {
      const p = profitDouble(t);
      if (p > 0) grossProfit += p;
    }
  }
  const costPercent = grossProfit > 0 ? (Math.abs(totalCosts) / grossProfit) * 100 : 0;

  const rows: SymbolCost[] = [];
  for (const [symbol, group] of groupByFirstAppearance(trades, (t) => t.symbol)) {
    let costs = 0;
    for (const t of group) costs += tradeCosts(t);
    let size = 0;
    for (const t of group) size += t.brand === "dojix" ? t.lots : t.shares;
    rows.push({ symbol, totalCosts: costs, totalSize: size, costPerUnit: size > 0 ? Math.abs(costs) / size : 0 });
  }
  const symbolCosts = stableSorted(rows, (a, b) => Math.abs(a.totalCosts) > Math.abs(b.totalCosts));

  return {
    hasCostData,
    totalCommissions,
    totalSwap,
    totalCosts,
    avgCostPerTrade,
    grossProfit,
    costPercent,
    symbolCosts,
    costLevel: costPercent < 5 ? "green" : costPercent < 15 ? "yellow" : "red",
    insightText: `Costs consume ${formatFixed(costPercent, 1)}% of gross profit`,
  };
}

export const commissionAnalyticsComponent = defineComponent<BrandId, CommissionAnalyticsModel>({
  id: "CommissionAnalytics",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 0,
  // The card always renders; without costs it shows its explanation (`emptyState`).
  compute: (ctx, trades) => {
    const m = computeCommissionAnalytics(ctx, trades);
    return m.hasCostData ? m : null;
  },
});

export const commissionAnalyticsParity: ComponentParity<CommissionAnalyticsModel> = {
  component: "CommissionAnalytics",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades, instance) => (instance === undefined ? computeCommissionAnalytics(ctx, trades) : undefined),
  members: {
    hasCostData: (m) => m.hasCostData,
    totalCommissions: (m) => m.totalCommissions,
    totalSwap: (m) => m.totalSwap,
    totalCosts: (m) => m.totalCosts,
    avgCostPerTrade: (m) => m.avgCostPerTrade,
    grossProfit: (m) => m.grossProfit,
    costPercent: (m) => m.costPercent,
    // SymbolCost: stored symbol, totalCosts, totalLots|totalShares + the computed costPerLot|costPerShare.
    symbolCosts: (m, ctx) =>
      m.symbolCosts.map((s) =>
        ctx.brand === "greenwick"
          ? { symbol: s.symbol, totalCosts: s.totalCosts, totalShares: s.totalSize, costPerShare: s.costPerUnit }
          : { symbol: s.symbol, totalCosts: s.totalCosts, totalLots: s.totalSize, costPerLot: s.costPerUnit },
      ),
  },
};
