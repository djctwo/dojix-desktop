// ChecklistAnalytics (SPEC Appendix A): rule compliance and the P&L impact of each rule.
//
// Port of Dojix `Components/ChecklistAnalytics.swift:8-67` and Greenwick
// `Components/ChecklistAnalytics.swift` (identical computation). Trades with checklist data;
// at least 5 (`hasData`). Per rule: followed vs broken (average P&L, WR%), compliance %,
// impact = avgFollowed − avgBroken, sorted by impact descending. Overall compliance = checked
// items / items. "All followed" and "any broken" averages.
//
// Trap: the Mac builds the rule list from a Set (random order), so rules with equal impact come
// out in random order; the desktop keeps first-appearance order (trades in input order, rules
// in their stored order) for ties.

import type { BrandId } from "../brand";
import { defineComponent } from "../engine/registry";
import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { stableSorted } from "../swiftcompat/collections";
import { toRef, type ComponentParity } from "./support";

export interface RuleStats {
  id: string;
  rule: string;
  /** Percent of the rule's checks that were followed. */
  complianceRate: number;
  avgPnLFollowed: number;
  avgPnLBroken: number;
  dollarImpact: number;
  /** Percent. */
  winRateFollowed: number;
  /** Percent. */
  winRateBroken: number;
}

export interface ChecklistAnalyticsModel<T extends Trade = Trade> {
  clTrades: T[];
  hasData: boolean;
  ruleStats: RuleStats[];
  overallCompliance: number;
  allFollowedAvg: number;
  anyBrokenAvg: number;
  /** All trades (the header's "x/y with checklist"). */
  totalTrades: number;
}

function avgProfit(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  let total = 0;
  for (const t of trades) total += profitDouble(t);
  return total / trades.length;
}

function winRatePct(trades: readonly Trade[]): number {
  if (trades.length === 0) return 0;
  let wins = 0;
  for (const t of trades) if (isWin(t)) wins += 1;
  return (wins / trades.length) * 100;
}

export function computeChecklistAnalytics<T extends Trade>(trades: readonly T[]): ChecklistAnalyticsModel<T> {
  const clTrades = trades.filter((t) => Object.keys(t.checklist).length > 0);
  const hasData = clTrades.length >= 5;

  let ruleStats: RuleStats[] = [];
  let overallCompliance = 0;
  if (hasData) {
    const followed = new Map<string, Trade[]>();
    const broken = new Map<string, Trade[]>();
    const rules: string[] = [];
    const seen = new Set<string>();
    let total = 0;
    let checked = 0;
    for (const t of clTrades) {
      for (const [rule, ok] of Object.entries(t.checklist)) {
        if (!seen.has(rule)) {
          seen.add(rule);
          rules.push(rule);
        }
        const target = ok ? followed : broken;
        const list = target.get(rule) ?? [];
        list.push(t);
        target.set(rule, list);
        total += 1;
        if (ok) checked += 1;
      }
    }
    const rows = rules.map((rule): RuleStats => {
      const f = followed.get(rule) ?? [];
      const b = broken.get(rule) ?? [];
      const count = f.length + b.length;
      const avgF = avgProfit(f);
      const avgB = avgProfit(b);
      return {
        id: rule,
        rule,
        complianceRate: count > 0 ? (f.length / count) * 100 : 0,
        avgPnLFollowed: avgF,
        avgPnLBroken: avgB,
        dollarImpact: avgF - avgB,
        winRateFollowed: winRatePct(f),
        winRateBroken: winRatePct(b),
      };
    });
    ruleStats = stableSorted(rows, (a, b) => a.dollarImpact > b.dollarImpact);
    overallCompliance = total > 0 ? (checked / total) * 100 : 0;
  }

  const full = clTrades.filter((t) => Object.values(t.checklist).every((v) => v));
  const partial = clTrades.filter((t) => Object.values(t.checklist).includes(false));
  return {
    clTrades,
    hasData,
    ruleStats,
    overallCompliance,
    allFollowedAvg: avgProfit(full),
    anyBrokenAvg: avgProfit(partial),
    totalTrades: trades.length,
  };
}

export const checklistAnalyticsComponent = defineComponent<BrandId, ChecklistAnalyticsModel>({
  id: "ChecklistAnalytics",
  brands: ["dojix", "greenwick"],
  tab: "behavioral",
  minTrades: 0,
  compute: (_ctx, trades) => {
    const m = computeChecklistAnalytics(trades);
    return m.hasData ? m : null;
  },
});

export const checklistAnalyticsParity: ComponentParity<ChecklistAnalyticsModel> = {
  component: "ChecklistAnalytics",
  brands: ["dojix", "greenwick"],
  compute: (_ctx, trades) => computeChecklistAnalytics(trades),
  members: {
    clTrades: (m) => toRef(m.clTrades),
    hasData: (m) => m.hasData,
    ruleStats: (m) => toRef(m.ruleStats),
    overallCompliance: (m) => m.overallCompliance,
    allFollowedAvg: (m) => m.allFollowedAvg,
    anyBrokenAvg: (m) => m.anyBrokenAvg,
  },
};
