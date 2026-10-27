// KillZoneOptimizer (Sessions tab, both brands). SPEC Appendix A "KillZone".
//
// Dojix `Components/KillZoneOptimizer.swift:18-41,49,184-254`; Greenwick (:18,24,185-252).
//
// - needs n ≥ 30 (`isActionable`);
// - trading days, at least 1: Dojix counts distinct `Calendar.current` days of the **open**
//   (PARITY D-08: `fixed` counts close days, like WhatToCut); Greenwick counts ET close days;
// - per hour 0–23 (stored hour): P&L (input order), count, WR% (0 when empty);
// - an hour qualifies with ≥ 10 trades and P&L > 0 (recommend) or < 0 (avoid); consecutive
//   qualifying hours merge into a window (no wrap past 23);
// - window WR = Σ(WR × count) / Σcount; monthly impact = P&L × 21 / trading days;
// - windows sorted by |P&L| descending (stable); label "%02d-%02d UTC" (Greenwick "ET") with
//   the end hour + 1.

import type { EngineContext } from "../engine/context";
import { isActionable } from "../metrics/edges";
import { tradingDayCount } from "../metrics/trading-days";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, stableSorted } from "../swiftcompat/collections";
import { formatFixed, swiftFormat } from "../swiftcompat/format";
import { percentOf, sumProfit, winCount } from "./shared";

export interface HourStats {
  hour: number;
  pnl: number;
  count: number;
  /** Percent; 0 without trades. */
  winRate: number;
}

export interface TimeWindow {
  startHour: number;
  endHour: number;
  pnl: number;
  count: number;
  /** Percent, count-weighted. */
  winRate: number;
  monthlyImpact: number;
  label: string;
}

/** The 24-slot timeline (KillZoneOptimizer.swift:208-211). */
export type KillZoneSlot = "insufficient" | "positive" | "negative";

export interface KillZoneModel {
  tradingDays: number;
  /** Which close/open day rule counted `tradingDays` (D-08). */
  tradingDaysBy: "open" | "close";
  hourlyStats: HourStats[];
  /** Per hour: fewer than 10 trades, P&L ≥ 0, or P&L < 0. */
  timeline: KillZoneSlot[];
  recommendWindows: TimeWindow[];
  avoidWindows: TimeWindow[];
  /** Σ monthly impact of the recommended windows. */
  topWindowMonthlyPnL: number;
  /** n ≥ 30; below it "Need at least 30 trades for kill zone analysis". */
  isActionable: boolean;
  sampleSize: number;
}

export const KILL_ZONE_MIN_HOUR_TRADES = 10;

function windowLabel(ctx: EngineContext, startHour: number, endHour: number): string {
  return swiftFormat(ctx.brand === "dojix" ? "%02d-%02d UTC" : "%02d-%02d ET", startHour, endHour + 1);
}

function makeWindow(ctx: EngineContext, hours: readonly HourStats[], monthScale: number): TimeWindow {
  let pnl = 0;
  let count = 0;
  let wins = 0;
  for (const h of hours) pnl += h.pnl;
  for (const h of hours) count += h.count;
  for (const h of hours) wins += h.winRate * h.count;
  const startHour = (hours[0] as HourStats).hour;
  const endHour = (hours[hours.length - 1] as HourStats).hour;
  return {
    startHour,
    endHour,
    pnl,
    count,
    winRate: count > 0 ? wins / count : 0,
    monthlyImpact: pnl * monthScale,
    label: windowLabel(ctx, startHour, endHour),
  };
}

function buildWindows(ctx: EngineContext, hourlyStats: readonly HourStats[], tradingDays: number, profitable: boolean): TimeWindow[] {
  const qualifies = (s: HourStats) => s.count >= KILL_ZONE_MIN_HOUR_TRADES && (profitable ? s.pnl > 0 : s.pnl < 0);
  if (!hourlyStats.some(qualifies)) return [];
  const monthScale = 21.0 / tradingDays;
  const windows: TimeWindow[] = [];
  let current: HourStats[] = [];
  for (const stat of hourlyStats) {
    if (qualifies(stat)) {
      current.push(stat);
    } else if (current.length > 0) {
      windows.push(makeWindow(ctx, current, monthScale));
      current = [];
    }
  }
  if (current.length > 0) windows.push(makeWindow(ctx, current, monthScale));
  return stableSorted(windows, (a, b) => Math.abs(a.pnl) > Math.abs(b.pnl));
}

export function killZoneOptimizer(ctx: EngineContext, trades: readonly Trade[]): KillZoneModel {
  const by: "open" | "close" = ctx.brand === "dojix" && ctx.compat === "swift" ? "open" : "close";
  const tradingDays = Math.max(tradingDayCount(trades, ctx.calendar, by), 1);
  const grouped = groupByFirstAppearance(trades, (t) => t.hour);
  const hourlyStats: HourStats[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const hourTrades = grouped.get(hour) ?? [];
    hourlyStats.push({
      hour,
      pnl: sumProfit(hourTrades),
      count: hourTrades.length,
      winRate: hourTrades.length === 0 ? 0 : percentOf(winCount(hourTrades), hourTrades.length),
    });
  }
  const recommendWindows = buildWindows(ctx, hourlyStats, tradingDays, true);
  const avoidWindows = buildWindows(ctx, hourlyStats, tradingDays, false);
  let topWindowMonthlyPnL = 0;
  for (const w of recommendWindows) topWindowMonthlyPnL += w.monthlyImpact;
  return {
    tradingDays,
    tradingDaysBy: by,
    hourlyStats,
    timeline: hourlyStats.map((s) => (s.count < KILL_ZONE_MIN_HOUR_TRADES ? "insufficient" : s.pnl >= 0 ? "positive" : "negative")),
    recommendWindows,
    avoidWindows,
    topWindowMonthlyPnL,
    isActionable: isActionable(trades.length),
    sampleSize: trades.length,
  };
}

/** The exported table (KillZoneOptimizer.swift:185-196, Greenwick :185-196). */
export function killZoneCsvRows(model: Pick<KillZoneModel, "recommendWindows" | "avoidWindows" | "hourlyStats">): string[][] {
  const rows: string[][] = [["Type", "Window", "P&L", "Win Rate", "Trades", "Monthly Impact"]];
  for (const [type, windows] of [
    ["Recommend", model.recommendWindows],
    ["Avoid", model.avoidWindows],
  ] as const) {
    for (const w of windows) {
      rows.push([type, w.label, formatFixed(w.pnl, 2), formatFixed(w.winRate, 1), String(w.count), formatFixed(w.monthlyImpact, 2)]);
    }
  }
  rows.push([]);
  rows.push(["Hour", "P&L", "Trades", "Win Rate"]);
  for (const s of model.hourlyStats) {
    if (s.count > 0) rows.push([`${s.hour}:00`, formatFixed(s.pnl, 2), String(s.count), formatFixed(s.winRate, 1)]);
  }
  return rows;
}
