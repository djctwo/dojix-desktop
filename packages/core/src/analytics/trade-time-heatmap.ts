// TradeTimeHeatmap (Timing tab, both brands). SPEC Appendix A "TradeTimeHeatmap".
//
// Dojix `Components/TradeTimeHeatmap.swift:7-40,54,116-125`; Greenwick's copy keys by the ET
// weekday of the open (`entryWeekday`) instead of the stored label (:7,22).
//
// - a cell per Mon–Fri × hour 0–23 (key "<day>-<hour>", P&L summed in input order);
// - maxAbs over all 120 cells (`?? 1` never applies: the grid is never empty);
// - the view shows hours 6–21; opacity = .15 + .85 × min(|p| / maxAbs, 1) (0 intensity when
//   maxAbs = 0), green for p ≥ 0, red below; a cell without trades is blank.

import type { EngineContext } from "../engine/context";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftMin } from "../swiftcompat/collections";
import { entryDayLabel, maxAbsOr, WEEKDAY_ROWS } from "./shared";

export interface TradeTimeCell {
  id: string;
  day: string;
  hour: number;
  pnl: number;
  count: number;
}

export interface TradeTimeHeatmapModel {
  /** 5 × 24 cells, Monday first, hour ascending. */
  cells: TradeTimeCell[];
  maxAbsPnL: number;
  /** The hours the Mac view shows (6–21). */
  displayHours: number[];
  days: readonly string[];
}

/** The hours the view shows (TradeTimeHeatmap.swift:54: "6-21 UTC covers all trading"). */
export const TRADE_TIME_DISPLAY_HOURS: readonly number[] = Array.from({ length: 16 }, (_, i) => i + 6);

export function tradeTimeHeatmap(_ctx: EngineContext, trades: readonly Trade[]): TradeTimeHeatmapModel {
  const map = new Map<string, { pnl: number; count: number }>();
  for (const t of trades) {
    const key = `${entryDayLabel(t)}-${t.hour}`;
    const existing = map.get(key) ?? { pnl: 0, count: 0 };
    map.set(key, { pnl: existing.pnl + profitDouble(t), count: existing.count + 1 });
  }
  const cells: TradeTimeCell[] = [];
  for (const day of WEEKDAY_ROWS) {
    for (let hour = 0; hour < 24; hour++) {
      const key = `${day}-${hour}`;
      const data = map.get(key) ?? { pnl: 0, count: 0 };
      cells.push({ id: key, day, hour, pnl: data.pnl, count: data.count });
    }
  }
  return {
    cells,
    maxAbsPnL: maxAbsOr(
      cells.map((c) => c.pnl),
      1,
    ),
    displayHours: [...TRADE_TIME_DISPLAY_HOURS],
    days: WEEKDAY_ROWS,
  };
}

/** Cell intensity in [0, 1] (TradeTimeHeatmap.swift:117). */
export function tradeTimeIntensity(pnl: number, maxAbsPnL: number): number {
  return maxAbsPnL > 0 ? swiftMin(Math.abs(pnl) / maxAbsPnL, 1.0) : 0;
}

/** Fill opacity of a cell with trades (TradeTimeHeatmap.swift:121-125); null for an empty cell. */
export function tradeTimeOpacity(cell: Pick<TradeTimeCell, "pnl" | "count">, maxAbsPnL: number): number | null {
  if (cell.count === 0) return null;
  return 0.15 + tradeTimeIntensity(cell.pnl, maxAbsPnL) * 0.85;
}
