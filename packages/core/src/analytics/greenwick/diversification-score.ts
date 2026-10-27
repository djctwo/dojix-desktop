// DiversificationScore (Greenwick `Components/DiversificationScore.swift`): effective number of
// independent symbols from the correlation of their daily P&L, concentration by symbol and
// sector, and a letter grade.
//
// - Daily P&L per symbol is keyed by the ET date of the close.
// - Pearson correlation over the days both symbols traded (at least 2, else 0; 0 when either
//   series is flat). The Mac walks those days in `Set` order (random), which only moves the last
//   bits of the sums; the desktop walks them in date order.
// - effective N = N² / Σ corr² over the full N × N matrix (diagonal included); ratio = effN / N.
// - Grade: A when ratio > 0.7 and the top sector holds ≤ 40% of sector-tagged trades; else B
//   (> 0.5), C (> 0.3), D (> 0.2), F.

import { profitDouble } from "../../model/accessors";
import type { GreenwickTrade } from "../../model/trade";
import { stableSorted } from "../../swiftcompat/collections";
import { swiftFormat } from "../../swiftcompat/format";
import { TRADING_CALENDAR } from "../../time/us-market";
import { groupByString, sumProfit, swiftStringKey, swiftStringLess } from "./shared";

export type DiversificationGrade = "A" | "B" | "C" | "D" | "F";

/** `Grade.label`. */
export const DIVERSIFICATION_GRADE_LABELS: Readonly<Record<DiversificationGrade, string>> = {
  A: "Excellent",
  B: "Good",
  C: "Fair",
  D: "Poor",
  F: "Concentrated",
};

export interface SymbolConcentration {
  symbol: string;
  pnl: number;
  /** |pnl| as a percent of Σ|trade P&L|. */
  pct: number;
}

export interface SectorShare {
  sector: string;
  count: number;
  /** Percent of the sector-tagged trades. */
  pct: number;
}

export interface DiversificationScoreModel {
  /** Distinct symbols, sorted. */
  symbols: string[];
  /** Symbol → (ET day key → net P&L). */
  symbolDailyPnL: Map<string, Map<string, number>>;
  /** N × N, in `symbols` order ([[1]] for one symbol, [] for none). */
  correlationMatrix: number[][];
  effectivePositionCount: number;
  /** effectivePositionCount / N (0 without symbols). */
  ratio: number;
  /** > 0.7 "Well diversified", > 0.4 "Moderately diversified", else "Concentrated". */
  effectiveQuality: string;
  /** Top 5 by |P&L| (the card lists 3). Empty when every trade is breakeven. */
  topSymbolsByPnL: SymbolConcentration[];
  /** "Heavy concentration in X (Y% of total P&L)" when the top symbol is above 40%. */
  symbolWarning: string | null;
  /** By trade count, descending. Empty without sector data (the section is hidden). */
  sectorDistribution: SectorShare[];
  /** "Consider diversifying beyond X (Y% of trades)" when the top sector is above 60%. */
  sectorWarning: string | null;
  grade: DiversificationGrade;
  gradeLabel: string;
  gradeDetails: string;
}

/** `diversificationPearsonCorrelation` (:91-115) over `dates` in the given order. */
export function diversificationPearsonCorrelation(
  series1: ReadonlyMap<string, number>,
  series2: ReadonlyMap<string, number>,
  dates: readonly string[],
): number {
  const common = dates.filter((d) => series1.has(d) && series2.has(d));
  if (common.length < 2) return 0;
  const x = common.map((d) => series1.get(d) as number);
  const y = common.map((d) => series2.get(d) as number);
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i] as number;
    sy += y[i] as number;
  }
  const meanX = sx / n;
  const meanY = sy / n;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - meanX;
    const dy = (y[i] as number) - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }
  const denominator = Math.sqrt(sumX2 * sumY2);
  if (!(denominator > 0)) return 0;
  return sumXY / denominator;
}

/** `computeGrade` (:171-181). */
export function diversificationGrade(effectiveCount: number, actualCount: number, topSectorPct: number): DiversificationGrade {
  if (!(actualCount > 0)) return "F";
  const ratio = effectiveCount / actualCount;
  if (ratio > 0.7 && topSectorPct <= 40) return "A";
  if (ratio > 0.5) return "B";
  if (ratio > 0.3) return "C";
  if (ratio > 0.2) return "D";
  return "F";
}

/** `gradeSection` details (:436-456). */
export function diversificationGradeDetails(grade: DiversificationGrade, effective: number, actual: number, topSectorPct: number): string {
  const ratio = effective / actual;
  switch (grade) {
    case "A":
      return `Strong diversification. ${swiftFormat("%.0f%%", ratio * 100)} effective independence across ${actual} symbols with no sector exceeding 40%.`;
    case "B":
      return `Good spread. ${swiftFormat("%.0f%%", ratio * 100)} effective independence. Minor concentration could be improved.`;
    case "C":
      return `Moderate concentration. Only ${swiftFormat("%.1f", effective)} effective independent positions from ${actual} symbols. Returns are correlated.`;
    case "D":
      return `High concentration risk. Your ${actual} symbols behave like ${swiftFormat("%.1f", effective)} independent positions. Drawdowns will be amplified.`;
    case "F":
      return topSectorPct > 60
        ? `Extreme concentration. ${swiftFormat("%.0f%%", topSectorPct)} in one sector with highly correlated positions. A single adverse event could impact most of your portfolio.`
        : "Extreme concentration. Your symbols move together, providing almost no diversification benefit.";
  }
}

/**
 * DiversificationScore.swift:48-215. The card is hidden below 10 trades (the registry guard)
 * or 2 symbols.
 */
export function computeDiversificationScore(trades: readonly GreenwickTrade[]): DiversificationScoreModel {
  // symbols (:48-50) and symbolDailyPnL (:53-61), keyed by the first spelling of each symbol.
  const bySymbol = groupByString(trades, (t) => t.symbol);
  const symbols = stableSorted(
    bySymbol.map((g) => g.label),
    swiftStringLess,
  );

  const daily = new Map<string, Map<string, number>>();
  for (const s of symbols) daily.set(swiftStringKey(s), new Map());
  for (const t of trades) {
    const series = daily.get(swiftStringKey(t.symbol)) as Map<string, number>;
    const day = TRADING_CALENDAR.dayKey(t.closeTime);
    series.set(day, (series.get(day) ?? 0) + profitDouble(t));
  }
  const allDates = [...new Set([...daily.values()].flatMap((m) => [...m.keys()]))].sort();

  // correlationMatrix (:64-89)
  const n = symbols.length;
  const matrix = symbols.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    (matrix[i] as number[])[i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const corr = diversificationPearsonCorrelation(
        daily.get(swiftStringKey(symbols[i] as string)) as Map<string, number>,
        daily.get(swiftStringKey(symbols[j] as string)) as Map<string, number>,
        allDates,
      );
      (matrix[i] as number[])[j] = corr;
      (matrix[j] as number[])[i] = corr;
    }
  }

  // effectivePositionCount (:120-134): N itself below 2 symbols.
  let sumCorrSq = 0;
  for (const row of matrix) for (const c of row) sumCorrSq += c * c;
  const effective = n >= 2 && sumCorrSq > 0 ? (n * n) / sumCorrSq : n;

  // topSymbolsByPnL (:138-152)
  let totalAbsPnL = 0;
  for (const t of trades) totalAbsPnL += Math.abs(profitDouble(t));
  let topSymbolsByPnL: SymbolConcentration[] = [];
  if (totalAbsPnL > 0) {
    const rows = bySymbol.map((g) => ({ symbol: g.label, pnl: sumProfit(g.items) }));
    topSymbolsByPnL = stableSorted(rows, (a, b) => Math.abs(a.pnl) > Math.abs(b.pnl))
      .slice(0, 5)
      .map((r) => ({ ...r, pct: (Math.abs(r.pnl) / totalAbsPnL) * 100 }));
  }

  // sectorDistribution (:156-167)
  const withSector = trades.filter((t) => t.sector !== "");
  const sectorDistribution = stableSorted(
    groupByString(withSector, (t) => t.sector).map((g) => ({
      sector: g.label,
      count: g.items.length,
      pct: (g.items.length / withSector.length) * 100,
    })),
    (a, b) => a.count > b.count,
  );

  const topSectorPct = sectorDistribution[0]?.pct ?? 0;
  const grade = diversificationGrade(effective, n, topSectorPct);
  const ratio = n > 0 ? effective / n : 0;
  const topSymbol = topSymbolsByPnL[0];
  const topSector = sectorDistribution[0];

  return {
    symbols,
    symbolDailyPnL: new Map(symbols.map((s) => [s, daily.get(swiftStringKey(s)) as Map<string, number>])),
    correlationMatrix: matrix,
    effectivePositionCount: effective,
    ratio,
    effectiveQuality: ratio > 0.7 ? "Well diversified" : ratio > 0.4 ? "Moderately diversified" : "Concentrated",
    topSymbolsByPnL,
    symbolWarning:
      topSymbol && topSymbol.pct > 40
        ? `Heavy concentration in ${topSymbol.symbol} (${swiftFormat("%.0f%%", topSymbol.pct)} of total P&L)`
        : null,
    sectorDistribution,
    sectorWarning:
      topSector && topSector.pct > 60
        ? `Consider diversifying beyond ${topSector.sector} (${swiftFormat("%.0f%%", topSector.pct)} of trades)`
        : null,
    grade,
    gradeLabel: DIVERSIFICATION_GRADE_LABELS[grade],
    gradeDetails: diversificationGradeDetails(grade, effective, n, topSectorPct),
  };
}
