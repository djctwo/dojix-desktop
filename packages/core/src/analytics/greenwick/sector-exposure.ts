// SectorExposure (Greenwick `Components/SectorExposure.swift`): net P&L, trade count and win
// rate per sector, sorted by |P&L|, with a warning when one sector holds more than half of the
// sector-tagged trades. Trades without a sector are left out.

import type { GreenwickTrade } from "../../model/trade";
import { seqMax, stableSorted } from "../../swiftcompat/collections";
import { swiftFormat } from "../../swiftcompat/format";
import { groupByString, sumProfit, winCount } from "./shared";

export interface SectorStats {
  sector: string;
  totalPnL: number;
  tradeCount: number;
  /** Percent. */
  winRate: number;
}

export interface SectorConcentration {
  sector: string;
  /** Share of the sector-tagged trades, percent (> 50). */
  pct: number;
}

export interface SectorExposureModel {
  /** Some trade has a sector (else the card shows "Add sector data to trades for exposure analysis"). */
  hasSectorData: boolean;
  /** Sorted by |totalPnL| descending (stable; equal sizes keep first-appearance order). */
  sectorStats: SectorStats[];
  /** Largest |totalPnL| (bar scale), 1 when there are no sectors. */
  maxAbsPnL: number;
  concentration: SectorConcentration | null;
  /** "<sector> accounts for <pct>% of trades — consider diversifying", or null. */
  concentrationWarning: string | null;
  /** Sum of the sector totals in display order (the "Total" row). */
  totalPnL: number;
}

/** SectorExposure.swift:17-56. No minimum trade count. */
export function computeSectorExposure(trades: readonly GreenwickTrade[]): SectorExposureModel {
  const withSector = trades.filter((t) => t.sector !== "");
  const groups = groupByString(withSector, (t) => t.sector);

  // :21-32 — one row per sector, then `sorted { abs($0.totalPnL) > abs($1.totalPnL) }`.
  const rows: SectorStats[] = groups.map(({ label, items }) => ({
    sector: label,
    totalPnL: sumProfit(items),
    tradeCount: items.length,
    winRate: (winCount(items) / items.length) * 100,
  }));
  const sectorStats = stableSorted(rows, (a, b) => Math.abs(a.totalPnL) > Math.abs(b.totalPnL));

  // :43-56 — at most one sector can exceed 50%, so the dictionary order doesn't matter.
  let concentration: SectorConcentration | null = null;
  for (const { label, items } of groups) {
    const pct = (items.length / withSector.length) * 100;
    if (pct > 50) {
      concentration = { sector: label, pct };
      break;
    }
  }

  let totalPnL = 0;
  for (const s of sectorStats) totalPnL += s.totalPnL;

  return {
    hasSectorData: withSector.length > 0,
    sectorStats,
    maxAbsPnL: seqMax(sectorStats.map((s) => Math.abs(s.totalPnL))) ?? 1, // :39-41
    concentration,
    concentrationWarning: concentration
      ? `${concentration.sector} accounts for ${swiftFormat("%.0f", concentration.pct)}% of trades — consider diversifying`
      : null,
    totalPnL,
  };
}
