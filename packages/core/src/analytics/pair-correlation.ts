// PairCorrelation (Dojix) / SymbolCorrelation (Greenwick) (SPEC Appendix A "Pair /
// SymbolCorrelation"): Pearson correlation of daily P&L between traded symbols.
//
// Port of Dojix `Components/PairCorrelation.swift:19-108,255-289` and Greenwick
// `Components/SymbolCorrelation.swift:12-101,248-282` (identical math; member names differ:
// `pairs` / `pairDailyPnL` vs `symbols` / `symbolDailyPnL`).
//
// - Symbols: distinct, sorted with Swift `String <` (Unicode scalar order of the NFC form).
// - Daily P&L per symbol keyed by the close's day: Dojix `DateFormatter("yyyy-MM-dd")` in the
//   computer's zone (`ctx.calendar`), Greenwick `TradingCalendar.dayKey` (ET trading day).
// - Pearson over the dates both symbols traded (needs ≥ 2, else 0; 0 when either series is flat);
//   matrix diagonal 1; the insight averages the upper triangle (zeros included): > .6 high,
//   < −.3 good diversification, else moderate.
//
// Swift traps:
// - `commonDates` is a `Set`, so the Mac sums the series in random order; the desktop sums in
//   ascending date order (results agree to a few ulps, inside the parity tolerance).
// - The Swift unit test's own Pearson helper (AnalyticsComponentTests.swift:496-519) requires 5
//   common dates; the component requires only 2. The component's rule is ported.

import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import { type ComponentParity } from "./support";

/** Swift `String <`: compares the Unicode scalars of the NFC forms. */
export function swiftStringLess(a: string, b: string): boolean {
  const x = Array.from(a.normalize("NFC"), (c) => c.codePointAt(0) as number);
  const y = Array.from(b.normalize("NFC"), (c) => c.codePointAt(0) as number);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number);
  }
  return x.length < y.length;
}

export interface DailyPnLSeries {
  /** Symbol → (day key → P&L summed in input order). Every symbol is present. */
  data: Map<string, Map<string, number>>;
  /** Every day key with a trade, ascending. */
  allDates: string[];
}

export interface CorrelationQuality {
  /** Symbol pairs with ≥ 2 overlapping days. */
  sufficient: number;
  total: number;
  maxOverlap: number;
}

export type CorrelationInsightKind = "high" | "good" | "moderate";

export interface CorrelationCore {
  symbols: string[];
  dailyPnL: DailyPnLSeries;
  /** n×n, diagonal 1; [] with fewer than 2 symbols. */
  correlationMatrix: number[][];
  dataQualitySummary: CorrelationQuality;
  /** Average of the upper triangle, or null when there is no matrix. */
  averageCorrelation: number | null;
  insight: { kind: CorrelationInsightKind; text: string } | null;
}

/** Dojix `PairCorrelation`. */
export interface PairCorrelationModel extends CorrelationCore {
  pairs: string[];
  pairDailyPnL: DailyPnLSeries;
}

/** Greenwick `SymbolCorrelation`. */
export interface SymbolCorrelationModel extends CorrelationCore {
  symbolDailyPnL: DailyPnLSeries;
}

/**
 * `pearsonCorrelation(series1:series2:dates:)`: (correlation, overlapping day count). `dates`
 * is iterated in the given order (ascending on the desktop).
 */
export function pearsonCorrelation(
  series1: ReadonlyMap<string, number>,
  series2: ReadonlyMap<string, number>,
  dates: Iterable<string>,
): { correlation: number; overlap: number } {
  const common: string[] = [];
  for (const d of dates) if (series1.has(d) && series2.has(d)) common.push(d);
  if (common.length < 2) return { correlation: 0, overlap: common.length };
  const x = common.map((d) => series1.get(d) as number);
  const y = common.map((d) => series2.get(d) as number);
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (const v of x) sx += v;
  for (const v of y) sy += v;
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
  if (!(denominator > 0)) return { correlation: 0, overlap: n };
  return { correlation: sumXY / denominator, overlap: n };
}

function dayKeyOf(ctx: EngineContext, t: Trade): string {
  return ctx.calendar.dayKey(t.closeTime);
}

export function computeCorrelation(ctx: EngineContext, trades: readonly Trade[]): CorrelationCore {
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  symbols.sort((a, b) => (swiftStringLess(a, b) ? -1 : swiftStringLess(b, a) ? 1 : 0));

  const data = new Map<string, Map<string, number>>();
  for (const s of symbols) data.set(s, new Map());
  const dateSet = new Set<string>();
  for (const t of trades) {
    const key = dayKeyOf(ctx, t);
    const series = data.get(t.symbol) as Map<string, number>;
    series.set(key, (series.get(key) ?? 0) + profitDouble(t));
    dateSet.add(key);
  }
  const allDates = [...dateSet].sort();
  const n = symbols.length;

  const correlationMatrix: number[][] = [];
  let quality: CorrelationQuality = { sufficient: 0, total: 0, maxOverlap: 0 };
  if (n >= 2) {
    for (let i = 0; i < n; i++) correlationMatrix.push(new Array<number>(n).fill(0));
    let sufficient = 0;
    let total = 0;
    let maxOverlap = 0;
    for (let i = 0; i < n; i++) {
      (correlationMatrix[i] as number[])[i] = 1;
      for (let j = i + 1; j < n; j++) {
        const { correlation, overlap } = pearsonCorrelation(
          data.get(symbols[i] as string) as Map<string, number>,
          data.get(symbols[j] as string) as Map<string, number>,
          allDates,
        );
        (correlationMatrix[i] as number[])[j] = correlation;
        (correlationMatrix[j] as number[])[i] = correlation;
        total += 1;
        maxOverlap = swiftMax(maxOverlap, overlap);
        if (overlap >= 2) sufficient += 1;
      }
    }
    quality = { sufficient, total, maxOverlap };
  }

  // diversificationInsight (:255-289)
  let averageCorrelation: number | null = null;
  let insight: CorrelationCore["insight"] = null;
  if (correlationMatrix.length > 0 && n >= 2) {
    let totalCorr = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        totalCorr += (correlationMatrix[i] as number[])[j] as number;
        count += 1;
      }
    }
    const avg = totalCorr / count;
    averageCorrelation = avg;
    const what = ctx.brand === "dojix" ? "pairs" : "symbols";
    const shown = swiftFormat("%.2f", avg);
    if (avg > 0.6) {
      insight = { kind: "high", text: `High positive correlation (avg ${shown}) — concentrated risk across ${what}` };
    } else if (avg < -0.3) {
      insight = { kind: "good", text: `Good diversification (avg ${shown}) — ${what} offset each other's risk` };
    } else {
      insight = { kind: "moderate", text: `Moderate correlation (avg ${shown}) — reasonably diversified portfolio` };
    }
  }

  return { symbols, dailyPnL: { data, allDates }, correlationMatrix, dataQualitySummary: quality, averageCorrelation, insight };
}

export function computePairCorrelation(ctx: EngineContext, trades: readonly Trade[]): PairCorrelationModel {
  const core = computeCorrelation(ctx, trades);
  return { ...core, pairs: core.symbols, pairDailyPnL: core.dailyPnL };
}

export function computeSymbolCorrelation(ctx: EngineContext, trades: readonly Trade[]): SymbolCorrelationModel {
  const core = computeCorrelation(ctx, trades);
  return { ...core, symbolDailyPnL: core.dailyPnL };
}

export const pairCorrelationComponent = defineComponent<"dojix", PairCorrelationModel>({
  id: "PairCorrelation",
  brands: ["dojix"],
  tab: "advanced",
  minTrades: 0,
  // "Need trades in at least 2 pairs" below two symbols.
  compute: (ctx, trades) => {
    const m = computePairCorrelation(ctx, trades);
    return m.pairs.length < 2 ? null : m;
  },
});

export const symbolCorrelationComponent = defineComponent<"greenwick", SymbolCorrelationModel>({
  id: "SymbolCorrelation",
  brands: ["greenwick"],
  tab: "advanced",
  minTrades: 0,
  compute: (ctx, trades) => {
    const m = computeSymbolCorrelation(ctx, trades);
    return m.symbols.length < 2 ? null : m;
  },
});

/** The `(data:, allDates:)` tuple as the harness writes it (the Set as a sorted array). */
function refSeries(s: DailyPnLSeries): unknown {
  const data: Record<string, Record<string, number>> = {};
  for (const [sym, series] of s.data) {
    const days: Record<string, number> = {};
    for (const [d, v] of series) days[d] = v;
    data[sym] = days;
  }
  return { data, allDates: [...s.allDates] };
}

const refQuality = (q: CorrelationQuality) => ({ sufficient: q.sufficient, total: q.total, maxOverlap: q.maxOverlap });

export const pairCorrelationParity: ComponentParity<PairCorrelationModel> = {
  component: "PairCorrelation",
  brands: ["dojix"],
  compute: (ctx, trades) => computePairCorrelation(ctx, trades),
  members: {
    pairs: (m) => [...m.pairs],
    pairDailyPnL: (m) => refSeries(m.pairDailyPnL),
    correlationMatrix: (m) => m.correlationMatrix.map((r) => [...r]),
    dataQualitySummary: (m) => refQuality(m.dataQualitySummary),
  },
};

export const symbolCorrelationParity: ComponentParity<SymbolCorrelationModel> = {
  component: "SymbolCorrelation",
  brands: ["greenwick"],
  compute: (ctx, trades) => computeSymbolCorrelation(ctx, trades),
  members: {
    symbols: (m) => [...m.symbols],
    symbolDailyPnL: (m) => refSeries(m.symbolDailyPnL),
    correlationMatrix: (m) => m.correlationMatrix.map((r) => [...r]),
    dataQualitySummary: (m) => refQuality(m.dataQualitySummary),
  },
};
