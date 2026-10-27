// TradeComparison (SPEC Appendix A): best vs worst trade side by side.
//
// Port of Dojix `Components/TradeComparison.swift:7-13` and Greenwick
// `Components/TradeComparison.swift:7-13`: best = `max(by: profitDouble <)` (the **last** of
// equal maxima), worst = `min(by:)` (the **first** of equal minima), over the input order
// (repository order, close time descending).

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { maxBy, minBy } from "../swiftcompat/collections";
import { toRef, type ComponentParity } from "./support";

export interface TradeComparisonModel<T extends Trade = Trade> {
  bestTrade: T | null;
  worstTrade: T | null;
}

const byProfit = (a: Trade, b: Trade) => profitDouble(a) < profitDouble(b);

export function computeTradeComparison<T extends Trade>(trades: readonly T[]): TradeComparisonModel<T> {
  return { bestTrade: maxBy(trades, byProfit) ?? null, worstTrade: minBy(trades, byProfit) ?? null };
}

export const tradeComparisonComponent = defineComponent<BrandId, TradeComparisonModel>({
  id: "TradeComparison",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 1,
  compute: (_ctx, trades) => computeTradeComparison(trades),
});

export const tradeComparisonParity: ComponentParity<TradeComparisonModel> = {
  component: "TradeComparison",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computeTradeComparison(trades),
  members: {
    bestTrade: (m) => toRef(m.bestTrade),
    worstTrade: (m) => toRef(m.worstTrade),
  },
};
