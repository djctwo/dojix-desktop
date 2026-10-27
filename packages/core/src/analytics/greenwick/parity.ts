// Parity resolvers for the Greenwick-only components (SPEC §10.4). The Tier B harness reads each
// component's computed values by their Swift names ("GapAnalysis.overallFillRate") and encodes
// them by reflection (tools/swift-ref `RefSupport.swift`): structs become objects of their
// stored properties, a Trade becomes "#<ticket>", a Date ISO-8601 UTC text, an enum its raw
// value (plus "$case" and generated extras when it has computed properties), a dictionary an
// object. These resolvers produce the desktop value in the same shape.

import type { EngineContext } from "../../engine/context";
import type { GreenwickTrade, Trade } from "../../model/trade";
import { registerParityResolver } from "../../parity/reference";
import { computeDiversificationScore } from "./diversification-score";
import { computeEarningsImpact } from "./earnings-impact";
import { computeExecutionQuality, type HourSlippage } from "./execution-quality";
import { computeGapAnalysis } from "./gap-analysis";
import { computeIntradayEquityCurve } from "./intraday-equity-curve";
import { computeOpeningRange, type OpeningRangeBucket } from "./opening-range";
import { computeRegimeAnalysis, REGIME_ICONS, type Regime, type RegimeStats } from "./regime-analysis";
import { computeSectorExposure } from "./sector-exposure";
import { ticketRef } from "./shared";
import { computeVolumeAnalysis } from "./volume-analysis";

type Outputs = Readonly<Record<string, unknown>>;

const refs = (ts: readonly GreenwickTrade[]): string[] => ts.map(ticketRef);

const openingBucket = (b: OpeningRangeBucket | null) =>
  b && { id: b.id, label: b.label, tradeCount: b.tradeCount, winRate: b.winRate, avgPnL: b.avgPnL, totalPnL: b.totalPnL };

const hourSlippage = (h: HourSlippage | null) => h && { id: h.hour, hour: h.hour, avgSlippage: h.avgSlippage, tradeCount: h.tradeCount };

/** `Regime` is RefDumpable: {"$case", "$raw", "icon"} (the colour is omitted). */
const regimeRef = (r: Regime | null) => r && { $case: r.toLowerCase(), $raw: r, icon: REGIME_ICONS[r] };

const regimeStats = (s: RegimeStats | null) =>
  s && { id: s.regime, regime: regimeRef(s.regime), dayCount: s.dayCount, winRate: s.winRate, avgPnL: s.avgPnL, totalPnL: s.totalPnL };

const objectOf = <V, W>(m: ReadonlyMap<string, V>, f: (v: V) => W): Record<string, W> => {
  const o: Record<string, W> = {};
  for (const [k, v] of m) o[k] = f(v);
  return o;
};

/** Every value the harness reads, per component, from the desktop models. */
export const GREENWICK_ONLY_PARITY_OUTPUTS: Readonly<Record<string, (ctx: EngineContext, trades: readonly GreenwickTrade[]) => Outputs>> = {
  SectorExposure: (_ctx, trades) => {
    const m = computeSectorExposure(trades);
    return {
      sectorStats: m.sectorStats.map((s) => ({ id: s.sector, sector: s.sector, totalPnL: s.totalPnL, tradeCount: s.tradeCount, winRate: s.winRate })),
      hasSectorData: m.hasSectorData,
      maxAbsPnL: m.maxAbsPnL,
      concentrationWarning: m.concentrationWarning,
    };
  },
  VolumeAnalysis: (ctx, trades) => {
    const m = computeVolumeAnalysis(trades, ctx.locale);
    return { tradesWithVolume: refs(m.tradesWithVolume), hasVolumeData: m.hasVolumeData, buckets: m.buckets, insightText: m.insightText };
  },
  GapAnalysis: (ctx, trades) => {
    const m = computeGapAnalysis(trades, ctx.locale);
    return {
      gapTrades: m.gapTrades.map((g) => ({
        trade: ticketRef(g.trade),
        gapType: g.gapType,
        gapPercent: g.gapPercent,
        previousClose: g.previousClose,
        gapFilled: g.gapFilled,
      })),
      hasEnoughData: m.hasEnoughData,
      overallFillRate: m.overallFillRate,
      bestStrategy: m.bestStrategy,
    };
  },
  OpeningRangeAnalysis: (ctx, trades) => {
    const m = computeOpeningRange(trades, ctx.locale);
    return {
      buckets: m.buckets.map(openingBucket),
      activeBuckets: m.activeBuckets.map(openingBucket),
      bestBucket: openingBucket(m.bestBucket),
      worstBucket: openingBucket(m.worstBucket),
      hasData: m.hasData,
      insightText: m.insightText,
    };
  },
  ExecutionQuality: (ctx, trades) => {
    const m = computeExecutionQuality(trades, ctx.compat);
    return {
      tradesWithSlippage: refs(m.tradesWithSlippage),
      hourlySlippage: m.hourlySlippage.map(hourSlippage),
      worstHour: hourSlippage(m.worstHour),
      symbolSlippage: m.symbolSlippage.map((s) => ({ id: s.symbol, ...s })),
      executionScore: m.executionScore,
      scoreLabel: m.scoreLabel,
      maxHourlySlippage: m.maxHourlySlippage,
    };
  },
  IntradayEquityCurve: (_ctx, trades) => {
    const m = computeIntradayEquityCurve(trades);
    return {
      hourBuckets: m.hourBuckets.map((b) => ({ id: b.hour, hour: b.hour, avgPnL: b.avgPnL, tradeCount: b.tradeCount, cumulativePnL: b.cumulativePnL })),
      morningPnL: m.morningPnL,
      afternoonPnL: m.afternoonPnL,
      insightText: m.insightText,
      maxAbsCumulative: m.maxAbsCumulative,
    };
  },
  RegimeAnalysis: (ctx, trades) => {
    const m = computeRegimeAnalysis(trades, ctx.compat, ctx.locale);
    return {
      medianDayMAE: m.medianDayMAE,
      tradingDays: m.tradingDays.map((d) => ({
        id: d.dayKey,
        date: new Date(d.date).toISOString(),
        trades: refs(d.trades),
        winRate: d.winRate,
        avgPnL: d.avgPnL,
        totalPnL: d.totalPnL,
        avgMAE: d.avgMAE,
        avgWinner: d.avgWinner,
        avgLoser: d.avgLoser,
        regime: regimeRef(d.regime),
      })),
      regimeStats: m.regimeStats.map(regimeStats),
      bestRegime: regimeStats(m.bestRegime),
      worstRegime: regimeStats(m.worstRegime),
      currentRegime: regimeRef(m.currentRegime),
      maxRegimeDays: m.maxRegimeDays,
    };
  },
  EarningsImpact: (ctx, trades) => {
    const m = computeEarningsImpact(trades, ctx.compat);
    return {
      analysis: { catalystTrades: refs(m.catalystTrades), normalTrades: refs(m.normalTrades), heldThroughTrades: refs(m.heldThroughTrades) },
    };
  },
  DiversificationScore: (_ctx, trades) => {
    const m = computeDiversificationScore(trades);
    return {
      symbols: m.symbols,
      symbolDailyPnL: objectOf(m.symbolDailyPnL, (days) => objectOf(days, (v) => v)),
      correlationMatrix: m.correlationMatrix,
      effectivePositionCount: m.effectivePositionCount,
      topSymbolsByPnL: m.topSymbolsByPnL,
      sectorDistribution: m.sectorDistribution,
    };
  },
};

const INTEGER_KEYS = ["RegimeAnalysis.maxRegimeDays"];

const cache = new WeakMap<readonly Trade[], Map<string, Outputs>>();

for (const [component, outputs] of Object.entries(GREENWICK_ONLY_PARITY_OUTPUTS)) {
  const prefix = `${component}.`;
  registerParityResolver(
    prefix,
    (key, ctx, trades) => {
      if (ctx.brand !== "greenwick") return undefined;
      let perTrades = cache.get(trades);
      if (!perTrades) {
        perTrades = new Map();
        cache.set(trades, perTrades);
      }
      const memo = `${component}|${ctx.compat}`;
      let values = perTrades.get(memo);
      if (!values) {
        values = outputs(ctx, trades as readonly GreenwickTrade[]);
        perTrades.set(memo, values);
      }
      const field = key.slice(prefix.length);
      return Object.hasOwn(values, field) ? { value: values[field] } : undefined;
    },
    INTEGER_KEYS.filter((k) => k.startsWith(prefix)),
  );
}
