// TagAnalytics (SPEC Appendix A): P&L per user tag.
//
// Port of Dojix `Components/TagAnalytics.swift:17-37` and Greenwick
// `Components/TagAnalytics.swift:17-37` (identical). A tag counts every trade that carries it
// (a trade tagged "a, a" counts twice for "a", as `tagList` keeps duplicates); per tag: profit,
// count, WR%, avgR; sorted by |profit| descending; the chart shows the first 8 (line 57).
//
// Determinism: the Mac builds a `[String: [Trade]]` and maps it, so tags with equal |profit|
// come out in random order. The desktop orders them by first appearance (stable sort).

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import type { ComponentParity } from "./support";

/** `TagAnalytics.TagData` (all stored). */
export interface TagData {
  id: string;
  tag: string;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
  avgR: number;
}

export interface TagAnalyticsModel {
  tagData: TagData[];
  /** Trades with at least one tag. */
  taggedTradeCount: number;
  /** View: the chart's rows (first 8). */
  chartData: TagData[];
}

/** `tag → trades` in first-appearance order (a trade appears once per occurrence of the tag). */
export function tradesByTag<T extends Trade>(trades: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of trades) {
    for (const tag of t.tags) {
      let list = out.get(tag);
      if (!list) {
        list = [];
        out.set(tag, list);
      }
      list.push(t);
    }
  }
  return out;
}

export function computeTagAnalytics(trades: readonly Trade[]): TagAnalyticsModel {
  const rows: TagData[] = [];
  for (const [tag, tagged] of tradesByTag(trades)) {
    let profit = 0;
    let wins = 0;
    let rSum = 0;
    for (const t of tagged) {
      profit += profitDouble(t);
      if (isWin(t)) wins += 1;
      rSum += t.rMultiple;
    }
    rows.push({ id: tag, tag, profit, tradeCount: tagged.length, winRate: (wins / tagged.length) * 100, avgR: rSum / tagged.length });
  }
  const tagData = stableSorted(rows, (a, b) => Math.abs(a.profit) > Math.abs(b.profit));
  let taggedTradeCount = 0;
  for (const t of trades) if (t.tags.length > 0) taggedTradeCount += 1;
  return { tagData, taggedTradeCount, chartData: tagData.slice(0, 8) };
}

export const tagAnalyticsComponent = defineComponent<BrandId, TagAnalyticsModel>({
  id: "TagAnalytics",
  brands: ["dojix", "greenwick"],
  tab: "edgeReport",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computeTagAnalytics(trades);
    return m.tagData.length === 0 ? null : m;
  },
});

export const tagAnalyticsParity: ComponentParity<TagAnalyticsModel> = {
  component: "TagAnalytics",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computeTagAnalytics(trades),
  members: {
    tagData: (m) => m.tagData.map((d) => ({ ...d })),
    taggedTradeCount: (m) => m.taggedTradeCount,
  },
  integerMembers: ["taggedTradeCount"],
};
