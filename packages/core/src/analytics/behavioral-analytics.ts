// BehavioralAnalytics, the "Discipline Score" (SPEC Appendix A).
//
// Port of Dojix `Components/BehavioralAnalytics.swift:33-174` and Greenwick
// `Components/BehavioralAnalytics.swift:32-174`. n ≥ 15, ASC by close time.
// - Days: Dojix groups by the close's day on the computer's calendar (`Calendar.current`,
//   line 38-43 → `ctx.calendar`); Greenwick by the ET trading day of the close (line 43).
// - Overtrading: a day with count > max(2 × avgDaily, 5); revenge: the next trade opens
//   0–600 s after a loss closes; tilt: a loss followed by ≥ 2 more losses closing within 60 min,
//   capped at n/5 (integer division); size ratio = mean size after a non-win (breakevens
//   included) / mean size after a win.
// - Scores: Dojix `max(0, Int(saturating:))` (Numeric+Safe.swift:11-21); Greenwick
//   `clampedScore` (line 33-36: +∞ → 100, NaN/−∞ → 0, else clamp to 0–100 and round down).
//   Overall = Σ / 4 (Dojix `saturatingSum()`, Greenwick `reduce(0, +)`; the scores are 0–100).
//
// Trap: the overtrading P&L is summed while iterating a Dictionary (random order on the Mac),
// so its last bits are not reproducible there; the desktop walks days in first-appearance
// (ascending) order.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isLoss, isWin, profitDouble, quantity } from "../model/accessors";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, swiftMax } from "../swiftcompat/collections";
import { asCurrency, swiftFormat } from "../swiftcompat/format";
import { idiv, intSaturating, saturatingSum } from "../swiftcompat/int";
import { toRef, type ComponentParity } from "./support";

export interface BehaviorDimension {
  name: string;
  /** 0–100. */
  score: number;
  detail: string;
  icon: string;
}

export interface BehaviorReport {
  disciplineScore: number;
  grade: string;
  overtradingDays: number;
  overtradingDaysPnL: number;
  revengeTrades: number;
  /** Fraction 0–1. */
  revengeWinRate: number;
  revengePnL: number;
  tiltEvents: number;
  sizeEscalation: number;
  avgDailyTrades: number;
  dimensions: BehaviorDimension[];
}

export interface BehavioralAnalyticsModel {
  /** null below 15 trades. */
  report: BehaviorReport | null;
}

/** Greenwick `BehavioralAnalytics.clampedScore` (line 33-36). */
export function clampedScore(raw: number): number {
  if (!Number.isFinite(raw)) return raw === Infinity ? 100 : 0;
  return Math.floor(Math.max(0, Math.min(100, raw))) + 0; // + 0: Int(-0.0) is 0
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export function computeBehavioralAnalytics(ctx: EngineContext, trades: readonly Trade[]): BehavioralAnalyticsModel {
  const sorted = sortedByCloseAscending(trades);
  const n = sorted.length;
  if (n < 15) return { report: null };
  const greenwick = ctx.brand === "greenwick";
  const flavor = greenwick ? "greenwick" : "dojix";

  const days = groupByFirstAppearance(sorted, (t) => ctx.calendar.dayKey(t.closeTime));
  const tradingDays = days.size;
  const avgDaily = n / swiftMax(tradingDays, 1);

  // 1. Overtrading
  const threshold = swiftMax(avgDaily * 2, 5);
  let otDays = 0;
  let otPnL = 0;
  for (const dayTrades of days.values()) {
    if (dayTrades.length > threshold) {
      otDays += 1;
      let dayTotal = 0;
      for (const t of dayTrades) dayTotal += profitDouble(t);
      otPnL += dayTotal;
    }
  }

  // 2. Revenge
  let revengeTrades = 0;
  let revengeWins = 0;
  let revengePnL = 0;
  for (let i = 1; i < n; i++) {
    const prev = sorted[i - 1] as Trade;
    const curr = sorted[i] as Trade;
    if (!isLoss(prev)) continue;
    const gap = (curr.openTime - prev.closeTime) / 1000;
    if (gap >= 0 && gap <= 600) {
      revengeTrades += 1;
      revengePnL += profitDouble(curr);
      if (isWin(curr)) revengeWins += 1;
    }
  }
  const revengeWR = revengeTrades > 0 ? revengeWins / revengeTrades : 0;

  // 3. Tilt
  let tiltEvents = 0;
  for (let i = 0; i < n; i++) {
    const t = sorted[i] as Trade;
    if (!isLoss(t)) continue;
    const windowEnd = t.closeTime + 3_600_000;
    let losses = 1;
    for (let j = i + 1; j < n; j++) {
      const u = sorted[j] as Trade;
      if (!(u.closeTime <= windowEnd)) break;
      if (isLoss(u)) losses += 1;
    }
    if (losses >= 3) tiltEvents += 1;
  }
  tiltEvents = Math.min(tiltEvents, idiv(n, 5));

  // 4. Size escalation
  let afterWinSum = 0;
  let afterWinN = 0;
  let afterLossSum = 0;
  let afterLossN = 0;
  for (let i = 1; i < n; i++) {
    const size = quantity(sorted[i] as Trade);
    if (isWin(sorted[i - 1] as Trade)) {
      afterWinSum += size;
      afterWinN += 1;
    } else {
      afterLossSum += size;
      afterLossN += 1;
    }
  }
  const avgAfterWin = afterWinN === 0 ? 1 : afterWinSum / afterWinN;
  const avgAfterLoss = afterLossN === 0 ? 1 : afterLossSum / afterLossN;
  const sizeRatio = avgAfterWin > 0 ? avgAfterLoss / avgAfterWin : 1;

  const otScore = Math.max(0, 100 - otDays * 25);
  let revengeScore: number;
  if (revengeTrades === 0) revengeScore = 100;
  else {
    const revengePct = (revengeTrades / n) * 100;
    const raw = 100 - revengePct * 10;
    revengeScore = greenwick ? clampedScore(raw) : Math.max(0, intSaturating(raw, flavor));
  }
  const tiltScore = Math.max(0, 100 - tiltEvents * 20);
  let sizeScore: number;
  if (sizeRatio <= 1.05) sizeScore = 100;
  else if (sizeRatio <= 1.2) sizeScore = 75;
  else if (sizeRatio <= 1.5) sizeScore = 50;
  else {
    const raw = 100 - (sizeRatio - 1) * 80;
    sizeScore = greenwick ? clampedScore(raw) : Math.max(0, intSaturating(raw, flavor));
  }

  const dimensions: BehaviorDimension[] = [
    {
      name: "Overtrading",
      score: otScore,
      detail:
        otDays === 0 ? "No overtrading days detected" : `${otDays} day${plural(otDays)} with 2× avg volume (${asCurrency(otPnL, ctx.locale)} P&L)`,
      icon: "speedometer",
    },
    {
      name: "Revenge",
      score: revengeScore,
      detail:
        revengeTrades === 0
          ? "No revenge trades detected"
          : `${revengeTrades} trades within 10m of a loss (${intSaturating(revengeWR * 100, flavor)}% WR, ${asCurrency(revengePnL, ctx.locale)})`,
      icon: "flame",
    },
    {
      name: "Tilt Control",
      score: tiltScore,
      detail: tiltEvents === 0 ? "No tilt episodes detected" : `${tiltEvents} tilt event${plural(tiltEvents)} (3+ losses in 1hr)`,
      icon: "brain.head.profile",
    },
    {
      name: "Size Discipline",
      score: sizeScore,
      detail:
        sizeRatio <= 1.1
          ? greenwick
            ? "Consistent position sizing after wins and losses"
            : "Consistent lot sizing after wins and losses"
          : `${greenwick ? "Shares" : "Lots"} ${swiftFormat("%.0f%%", (sizeRatio - 1) * 100)} larger after losses — emotional sizing`,
      icon: "scalemass",
    },
  ];

  const overall = idiv(saturatingSum(dimensions.map((d) => d.score)), dimensions.length);
  const grade = overall >= 85 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : overall >= 40 ? "D" : "F";

  return {
    report: {
      disciplineScore: overall,
      grade,
      overtradingDays: otDays,
      overtradingDaysPnL: otPnL,
      revengeTrades,
      revengeWinRate: revengeWR,
      revengePnL,
      tiltEvents,
      sizeEscalation: sizeRatio,
      avgDailyTrades: avgDaily,
      dimensions,
    },
  };
}

export const behavioralAnalyticsComponent = defineComponent<BrandId, BehaviorReport>({
  id: "BehavioralAnalytics",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 15,
  compute: (ctx, trades) => computeBehavioralAnalytics(ctx, trades).report,
});

export const behavioralAnalyticsParity: ComponentParity<BehavioralAnalyticsModel> = {
  component: "BehavioralAnalytics",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeBehavioralAnalytics(ctx, trades),
  members: { report: (m) => toRef(m.report) },
};
