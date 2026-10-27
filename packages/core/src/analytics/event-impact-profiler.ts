// EventImpactProfiler (SPEC Appendix A "CalendarCorrelation / EventImpactProfiler"): per recurring
// event type, how the trades opened around it perform, with a TRADE / CAUTION / AVOID call.
//
// Port of Dojix `Components/EventImpactProfiler.swift:9,215-268,272-303,347-508` and Greenwick
// `Components/EventImpactProfiler.swift` (same lines; differences below).
//
// - Event matching (`matchesEvent`, :395-419) reads the open time with `Calendar.current` (Dojix)
//   or `TradingCalendar.calendar` (Greenwick, ET). Dojix events: NFP, FOMC, CPI, ECB, BOE,
//   Mon Open, Fri Close. Greenwick replaces ECB/BOE with Earnings (hour 16–18) and Jobs Report
//   (Fri, week 1, hour 8–14). Mon Open (< 9) and Fri Close (≥ 18) thresholds are the same in both
//   apps here (unlike CalendarCorrelation's Greenwick variant).
// - Per type with ≥ 3 matches: WRf, total and average P&L, avg R (R ≠ 0 only), PF (99 when no
//   losses but some profit, else 0); pre/during/post windows on the **stored** hour vs the typical
//   release hour (Dojix `typicalHourUTC`, Greenwick `typicalHourET`); TRADE (n ≥ 10, WR ≥ .55,
//   PF ≥ 1.2), AVOID (WR < .4 or PF < .8), else CAUTION (always CAUTION below 10).
// - Results sorted by match count descending (stable, so ties keep `allCases` order).
// - `tradingMonths` (:347-351): whole days from the earliest open to now on the **computer's**
//   calendar in both apps (`ctx.localCalendar`), ÷ 30 (integer division), at least 1.
//
// Divergences (fixed mode only): D-09 (Dojix heuristics in UTC) and D-19 (NFP / Jobs Report
// "week 1" = first Friday of the month), shared with CalendarCorrelation (`newsDateFields`).
//
// Swift traps: the symbol-impact table groups with a Dictionary and sorts by |delta| (ties are
// random on the Mac; first appearance here). `min(by:)`/`max(by:)` pick the first worst / last
// best event for the insight.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy, minBy, stableSorted, swiftMax } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import { idiv } from "../swiftcompat/int";
import { newsDateFields } from "./calendar-correlation";
import { toRef, type ComponentParity } from "./support";

export type EventRecommendation = "TRADE" | "CAUTION" | "AVOID";

/** `EventImpactProfiler.EventType` with its computed properties. */
export interface EventTypeInfo {
  /** Swift case name (`nfp`, `mondayOpen`, …). */
  caseName: string;
  /** Raw value shown in the UI ("NFP", "Mon Open", …). */
  rawValue: string;
  /** SF Symbol name on the Mac (the UI maps it to its own icon). */
  icon: string;
  /** Typical release hour: UTC (Dojix) or ET (Greenwick). */
  typicalHour: number;
  /** Dojix `affectedCurrencies` / Greenwick `affectedSectors`. */
  affected: readonly string[];
}

const FX_EVENTS: readonly EventTypeInfo[] = [
  { caseName: "nfp", rawValue: "NFP", icon: "person.3.fill", typicalHour: 13, affected: ["USD"] },
  { caseName: "fomc", rawValue: "FOMC", icon: "building.columns.fill", typicalHour: 19, affected: ["USD"] },
  { caseName: "cpi", rawValue: "CPI", icon: "chart.line.uptrend.xyaxis", typicalHour: 13, affected: ["USD"] },
  { caseName: "ecb", rawValue: "ECB", icon: "eurosign.circle.fill", typicalHour: 12, affected: ["EUR"] },
  { caseName: "boe", rawValue: "BOE", icon: "sterlingsign.circle.fill", typicalHour: 12, affected: ["GBP"] },
  { caseName: "mondayOpen", rawValue: "Mon Open", icon: "sunrise.fill", typicalHour: 0, affected: [] },
  { caseName: "fridayClose", rawValue: "Fri Close", icon: "sunset.fill", typicalHour: 21, affected: [] },
];

const ST_EVENTS: readonly EventTypeInfo[] = [
  { caseName: "nfp", rawValue: "NFP", icon: "person.3.fill", typicalHour: 8, affected: ["All"] },
  { caseName: "fomc", rawValue: "FOMC", icon: "building.columns.fill", typicalHour: 14, affected: ["All"] },
  { caseName: "cpi", rawValue: "CPI", icon: "chart.line.uptrend.xyaxis", typicalHour: 8, affected: ["All"] },
  { caseName: "earnings", rawValue: "Earnings", icon: "doc.text.fill", typicalHour: 16, affected: ["Reporting"] },
  { caseName: "jobsReport", rawValue: "Jobs Report", icon: "briefcase.fill", typicalHour: 8, affected: ["All"] },
  { caseName: "mondayOpen", rawValue: "Mon Open", icon: "sunrise.fill", typicalHour: 9, affected: [] },
  { caseName: "fridayClose", rawValue: "Fri Close", icon: "sunset.fill", typicalHour: 15, affected: [] },
];

/** `EventType.allCases` for a brand. */
export function eventTypesFor(brand: BrandId): readonly EventTypeInfo[] {
  return brand === "dojix" ? FX_EVENTS : ST_EVENTS;
}

const inRange = (x: number, lo: number, hi: number) => x >= lo && x <= hi;

/** `matchesEvent` (:395-419). */
export function matchesEvent(ctx: EngineContext, trade: Trade, eventType: EventTypeInfo): boolean {
  const { weekday: wd, day, month, hour, isFirstWeek } = newsDateFields(ctx, trade.openTime);
  switch (eventType.caseName) {
    case "nfp":
      return wd === 6 && isFirstWeek;
    case "fomc":
      return wd === 4 && [1, 3, 5, 6, 7, 9, 11, 12].includes(month) && inRange(day, 15, 28);
    case "cpi":
      return (wd === 3 || wd === 4) && inRange(day, 10, 14);
    case "ecb":
      return wd === 5 && [1, 3, 4, 6, 7, 9, 10, 12].includes(month) && inRange(day, 7, 21) && inRange(hour, 11, 15);
    case "boe":
      return wd === 5 && [2, 3, 5, 6, 8, 9, 11, 12].includes(month) && inRange(day, 1, 14) && inRange(hour, 10, 14);
    case "earnings":
      return hour >= 16 && hour <= 18;
    case "jobsReport":
      return wd === 6 && isFirstWeek && inRange(hour, 8, 14);
    case "mondayOpen":
      return wd === 2 && hour < 9;
    default: // fridayClose
      return wd === 6 && hour >= 18;
  }
}

/** `EventImpactProfiler.EventTypeResult`. */
export interface EventTypeResult<T extends Trade = Trade> {
  eventType: EventTypeInfo;
  trades: T[];
  /** Fraction 0–1. */
  winRate: number;
  avgPnL: number;
  avgR: number;
  totalPnL: number;
  /** 99 when there are wins and no losses; 0 with neither. */
  profitFactor: number;
  recommendation: EventRecommendation;
  preTrades: T[];
  duringTrades: T[];
  postTrades: T[];
}

export interface GroupStats {
  count: number;
  /** Fraction 0–1 (0 when empty). */
  winRate: number;
  /** 0 when empty. */
  avgPnL: number;
}

export interface SymbolImpactRow {
  symbol: string;
  eventWR: number;
  normalWR: number;
  delta: number;
  count: number;
}

export interface EventImpactProfilerModel<T extends Trade = Trade> {
  results: EventTypeResult<T>[];
  tradingMonths: number;
  /** Header count: `results.flatMap(\.trades).count` (a trade matching two events counts twice). */
  eventTradeCount: number;
  /** "Event days" vs "Quiet days" mini cards (quiet = tickets not in any result). */
  eventStats: GroupStats;
  quietStats: GroupStats;
  /** Timing cards (pre / during / post, over every result). */
  timing: { pre: GroupStats; during: GroupStats; post: GroupStats };
  /** Pair (Dojix) / symbol (Greenwick) impact rows: ≥ 5 event trades, |delta| descending. */
  symbolImpact: SymbolImpactRow[];
  insightText: string;
}

function statsOf(trades: readonly Trade[]): GroupStats {
  let wins = 0;
  let total = 0;
  for (const t of trades) {
    if (isWin(t)) wins += 1;
    total += profitDouble(t);
  }
  const n = trades.length;
  return { count: n, winRate: n === 0 ? 0 : wins / n, avgPnL: n === 0 ? 0 : total / n };
}

function analyzeByEventType<T extends Trade>(ctx: EngineContext, trades: readonly T[]): EventTypeResult<T>[] {
  const out: EventTypeResult<T>[] = [];
  for (const eventType of eventTypesFor(ctx.brand)) {
    const matching = trades.filter((t) => matchesEvent(ctx, t, eventType));
    if (matching.length < 3) continue;
    let winCount = 0;
    let totalPnL = 0;
    let rSum = 0;
    let rCount = 0;
    let grossWin = 0;
    let lossSum = 0;
    for (const t of matching) {
      const p = profitDouble(t);
      totalPnL += p;
      if (isWin(t)) {
        winCount += 1;
        grossWin += p;
      }
      if (isLoss(t)) lossSum += p;
      if (t.rMultiple !== 0) {
        rSum += t.rMultiple;
        rCount += 1;
      }
    }
    const winRate = winCount / matching.length;
    const avgPnL = totalPnL / matching.length;
    const avgR = rCount === 0 ? 0 : rSum / rCount;
    const grossLoss = Math.abs(lossSum);
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
    const h = eventType.typicalHour;
    const preTrades = matching.filter((t) => t.hour >= h - 2 && t.hour < h);
    const duringTrades = matching.filter((t) => t.hour === h || t.hour === h + 1);
    const postTrades = matching.filter((t) => t.hour > h + 1 && t.hour <= h + 3);
    let recommendation: EventRecommendation = "CAUTION";
    if (matching.length >= 10) {
      if (winRate >= 0.55 && pf >= 1.2) recommendation = "TRADE";
      else if (winRate < 0.4 || pf < 0.8) recommendation = "AVOID";
    }
    out.push({
      eventType,
      trades: matching,
      winRate,
      avgPnL,
      avgR,
      totalPnL,
      profitFactor: pf,
      recommendation,
      preTrades,
      duringTrades,
      postTrades,
    });
  }
  return stableSorted(out, (a, b) => a.trades.length > b.trades.length);
}

/** `tradingMonths` (:347-351), on the computer's calendar and `ctx.now`. */
export function eventTradingMonths(ctx: EngineContext, trades: readonly Trade[]): number {
  const first = minBy(trades, (a, b) => a.openTime < b.openTime);
  if (!first) return 1;
  const days = ctx.localCalendar.daysBetween(first.openTime, ctx.now);
  return swiftMax(1, idiv(days, 30));
}

export function computeEventImpactProfiler<T extends Trade>(ctx: EngineContext, trades: readonly T[]): EventImpactProfilerModel<T> {
  const results = analyzeByEventType(ctx, trades);
  const tradingMonths = eventTradingMonths(ctx, trades);
  const allEvent = results.flatMap((r) => r.trades);
  const eventIDs = new Set(allEvent.map((t) => t.ticket));
  const quiet = trades.filter((t) => !eventIDs.has(t.ticket));

  // symbolImpact / pairImpact (:215-228)
  const overallBySymbol = groupByFirstAppearance(trades, (t) => t.symbol);
  const rows: SymbolImpactRow[] = [];
  for (const [symbol, eventTrades] of groupByFirstAppearance(allEvent, (t) => t.symbol)) {
    if (eventTrades.length < 5) continue;
    const ewr = statsOf(eventTrades).winRate;
    const nwr = statsOf(overallBySymbol.get(symbol) ?? []).winRate;
    rows.push({ symbol, eventWR: ewr, normalWR: nwr, delta: ewr - nwr, count: eventTrades.length });
  }
  const symbolImpact = stableSorted(rows, (a, b) => Math.abs(a.delta) > Math.abs(b.delta));

  // insightBanner (:272-288)
  const worst = minBy(
    results.filter((r) => r.trades.length >= 5 && r.avgPnL < 0),
    (a, b) => a.avgPnL < b.avgPnL,
  );
  const best = maxBy(
    results.filter((r) => r.trades.length >= 5 && r.avgPnL > 0),
    (a, b) => a.avgPnL < b.avgPnL,
  );
  let insightText: string;
  if (worst && worst.trades.length >= 10) {
    const months = swiftMax(1, tradingMonths);
    const monthlyCost = Math.abs(worst.totalPnL) / months;
    insightText =
      `Skipping ${worst.eventType.rawValue} could save ~$${swiftFormat("%.0f", monthlyCost)}/month ` +
      `(${worst.trades.length} trades at $${swiftFormat("%.2f", worst.avgPnL)} avg).`;
  } else if (best) {
    insightText =
      `Best event: ${best.eventType.rawValue} — ${swiftFormat("%.0f%%", best.winRate * 100)} WR, ` +
      `$${swiftFormat("+%.2f", best.avgPnL)} avg per trade.`;
  } else {
    insightText = "Need more event-day trades for a recommendation. Keep trading and check back.";
  }

  return {
    results,
    tradingMonths,
    eventTradeCount: allEvent.length,
    eventStats: statsOf(allEvent),
    quietStats: statsOf(quiet),
    timing: {
      pre: statsOf(results.flatMap((r) => r.preTrades)),
      during: statsOf(results.flatMap((r) => r.duringTrades)),
      post: statsOf(results.flatMap((r) => r.postTrades)),
    },
    symbolImpact,
    insightText,
  };
}

export const eventImpactProfilerComponent = defineComponent<BrandId, EventImpactProfilerModel>({
  id: "EventImpactProfiler",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  // `if trades.count < 30 { EmptyView() }` (:12)
  minTrades: 30,
  compute: (ctx, trades) => computeEventImpactProfiler(ctx, trades),
});

/** The harness encoding of `EventType` (a RefDumpable enum with a raw value). */
function refEventType(e: EventTypeInfo, brand: BrandId): Record<string, unknown> {
  return brand === "dojix"
    ? { $case: e.caseName, $raw: e.rawValue, icon: e.icon, typicalHourUTC: e.typicalHour, affectedCurrencies: [...e.affected] }
    : { $case: e.caseName, $raw: e.rawValue, icon: e.icon, typicalHourET: e.typicalHour, affectedSectors: [...e.affected] };
}

export const eventImpactProfilerParity: ComponentParity<EventImpactProfilerModel> = {
  component: "EventImpactProfiler",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeEventImpactProfiler(ctx, trades),
  members: {
    results: (m, ctx) =>
      m.results.map((r) => ({
        ...(toRef({ ...r, eventType: undefined }) as Record<string, unknown>),
        eventType: refEventType(r.eventType, ctx.brand),
      })),
    tradingMonths: (m) => m.tradingMonths,
  },
  integerMembers: ["tradingMonths"],
};
