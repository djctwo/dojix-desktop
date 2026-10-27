// MonthlyReturns (SPEC Appendix A): P&L, trade count and win rate per calendar month, laid out as
// a year × month table with year totals and the best / worst month.
//
// Port of Dojix `Components/MonthlyReturns.swift:7-36,82,92-93` and Greenwick
// `Components/MonthlyReturns.swift:7-35,81,92-94`:
// - Month key "%04d-%02d" of the close on the brand calendar: Dojix `Calendar.current`
//   (`ctx.calendar`), Greenwick `TradingCalendar.monthKey` (the ET trading day's month, so a Friday
//   18:50 ET close on 31 July stays in July for a user anywhere).
// - Per month: profit (summed in input order), count, WR% (wins / count × 100); sorted by key.
// - Year total = Σ month profits in month order; best = `max(by:)` (last of ties), worst =
//   `min(by:)` (first of ties).
// - Greenwick also requires best.month and worst.month in 1…12 before showing them (always true
//   for keys it builds itself).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy, minBy, stableSorted } from "../swiftcompat/collections";
import { toRef, type ComponentParity } from "./support";

/** `MonthlyReturns.MonthData`. */
export interface MonthData {
  /** "2026-01". */
  id: string;
  year: number;
  month: number;
  profit: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
}

export interface MonthlyReturnsModel {
  /** Oldest first. */
  monthlyData: MonthData[];
  /** Distinct years, ascending. */
  years: number[];
  /** Year → Σ month profits. */
  yearTotals: Map<number, number>;
  best: MonthData | null;
  worst: MonthData | null;
}

/**
 * Swift `key.split(separator: "-")` (empty pieces dropped) then `Int(comps[i]) ?? 0`. The keys
 * come from `monthKey`, so both pieces are always digits (a year before 1 loses its sign, as on
 * the Mac).
 */
function keyParts(key: string): { year: number; month: number } {
  const comps = key.split("-").filter((c) => c !== "");
  return { year: Number(comps[0]), month: Number(comps[1]) };
}

export function computeMonthlyReturns(ctx: EngineContext, trades: readonly Trade[]): MonthlyReturnsModel {
  const grouped = groupByFirstAppearance(trades, (t) => ctx.calendar.monthKey(t.closeTime));
  const rows: MonthData[] = [];
  for (const [key, monthTrades] of grouped) {
    const { year, month } = keyParts(key);
    let profit = 0;
    let wins = 0;
    for (const t of monthTrades) {
      profit += profitDouble(t);
      if (isWin(t)) wins += 1;
    }
    rows.push({ id: key, year, month, profit, tradeCount: monthTrades.length, winRate: (wins / monthTrades.length) * 100 });
  }
  const monthlyData = stableSorted(rows, (a, b) => a.id < b.id);
  const years = [...new Set(monthlyData.map((m) => m.year))].sort((a, b) => a - b);
  const yearTotals = new Map<number, number>();
  for (const y of years) {
    let total = 0;
    for (const m of monthlyData) if (m.year === y) total += m.profit;
    yearTotals.set(y, total);
  }
  const byProfit = (a: MonthData, b: MonthData) => a.profit < b.profit;
  let best = maxBy(monthlyData, byProfit) ?? null;
  let worst = minBy(monthlyData, byProfit) ?? null;
  const inRange = (x: MonthData | null) => x !== null && x.month >= 1 && x.month <= 12;
  if (ctx.brand === "greenwick" && !(inRange(best) && inRange(worst))) {
    best = null;
    worst = null;
  }
  return { monthlyData, years, yearTotals, best, worst };
}

export const monthlyReturnsComponent = defineComponent<BrandId, MonthlyReturnsModel>({
  id: "MonthlyReturns",
  brands: ["dojix", "greenwick"],
  tab: { dojix: "overview", greenwick: "risk" },
  // "No trades yet" when monthlyData is empty.
  minTrades: 1,
  compute: (ctx, trades) => computeMonthlyReturns(ctx, trades),
});

export const monthlyReturnsParity: ComponentParity<MonthlyReturnsModel> = {
  component: "MonthlyReturns",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeMonthlyReturns(ctx, trades),
  members: {
    monthlyData: (m) => toRef(m.monthlyData),
    years: (m) => [...m.years],
  },
  integerMembers: ["years"],
};
