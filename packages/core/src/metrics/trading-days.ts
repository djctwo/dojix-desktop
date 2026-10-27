// Distinct trading days, the denominator of every "× 21 / tradingDays" monthly impact.
//
// - Dojix: `Set(trades.map { Calendar.current.startOfDay(for: $0.closeTime) }).count`
//   (WhatToCutAdvisor.swift:11-14, PropFirmTracker.swift:74-76). KillZone counts *open* days
//   (KillZoneOptimizer.swift:23-25) — PARITY D-08 moves it to close days in `fixed` mode.
// - Greenwick: ET close days (`TradingCalendar.tradingDayCount`).
// Pass the brand calendar (`ctx.calendar`).

import type { Trade } from "../model/trade";
import type { ZonedCalendar } from "../time/zoned-calendar";

export function tradingDayCount(
  trades: readonly Pick<Trade, "openTime" | "closeTime">[],
  calendar: ZonedCalendar,
  by: "close" | "open" = "close",
): number {
  const days = new Set<number>();
  for (const t of trades) days.add(calendar.startOfDay(by === "close" ? t.closeTime : t.openTime));
  return days.size;
}
