// EdgeDecayMonitor (SPEC Appendix A): rolling 30-trade edge, decay status and likely causes.
//
// Port of Dojix `Components/EdgeDecayMonitor.swift:11-189` and Greenwick
// `Components/EdgeDecayMonitor.swift:11-170`.
// - ASC by close time (stable). For every 30-trade window ending at i ≥ 29: WR as a **fraction**,
//   PF (5 when the window has wins and no losses), expectancy = WRf·avgWin − (1 − WRf)·avgLoss,
//   Sharpe = mean / σ_pop (0 when σ = 0) clamped to ±3, PF capped at 5; id = i,
//   tradeNumber = i + 1, date = the window's last close. Dojix also records the window's dominant
//   volatility regime.
// - Status: the last 30 points vs the 30 before them (fewer when short). Decaying when the mean PF
//   drops by more than 0.5 or mean expectancy by more than 30% (of |prior|); warning above
//   0.25 / 15%; otherwise healthy (also with < 2 points or no prior points).
// - Diagnoses (status not healthy and n ≥ 60), halves split at n/2:
//   regime shift (Dojix only), overtrading (trades per day up > 1.3×, decaying above 1.5×;
//   days = Dojix `Calendar.current` days, Greenwick ET trading days of the close),
//   strategy drift (sessions only in the second half), per-session WR drop > 15 (decaying > 25)
//   for sessions with ≥ 10 trades in each half, in enum order.
//
// Swift Dictionary / Set order is random. The desktop reads groups in first-appearance order:
// the dominant regime is `max(by:)` over that order (so the first of tied counts wins), and the
// new-session list is in first-appearance order in the second half.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { isLoss, isWin, profitDouble } from "../model/accessors";
import { MARKET_SESSIONS, MARKET_SESSION_INFO, TRADING_SESSIONS, TRADING_SESSION_INFO } from "../model/enums";
import type { Trade } from "../model/trade";
import { groupByFirstAppearance, maxBy, swiftMin } from "../swiftcompat/collections";
import { swiftFormat } from "../swiftcompat/format";
import { clamp, toRef, type ComponentParity } from "./support";

export const EDGE_DECAY_WINDOW = 30;

export interface RollingPoint {
  id: number;
  tradeNumber: number;
  /** Epoch ms of the window's last close. */
  date: number;
  /** Clamped to ±3. */
  sharpe: number;
  /** Capped at 5. */
  pf: number;
  expectancy: number;
  /** Dojix only: the window's dominant volatility regime raw value. */
  volRegime?: string;
}

export type DecayStatus = "healthy" | "warning" | "decaying";

export const DECAY_STATUS_INFO: Readonly<Record<DecayStatus, { label: string; icon: string }>> = {
  healthy: { label: "Healthy", icon: "checkmark.seal.fill" },
  warning: { label: "Warning", icon: "exclamationmark.triangle.fill" },
  decaying: { label: "Decaying", icon: "chart.line.downtrend.xyaxis" },
};

export interface DecayDiagnosis {
  dimension: string;
  detail: string;
  severity: DecayStatus;
}

export interface EdgeDecayMonitorModel<T extends Trade = Trade> {
  sorted: T[];
  rollingData: RollingPoint[];
  status: DecayStatus;
  diagnoses: DecayDiagnosis[];
  /** n ≥ 60: the chart and diagnoses are shown. */
  hasEnoughData: boolean;
}

function dominant<T>(items: readonly T[], key: (t: T) => string): string {
  const groups = groupByFirstAppearance(items, key);
  return maxBy([...groups], (a, b) => a[1].length < b[1].length)?.[0] ?? "MED";
}

function rolling(ctx: EngineContext, sorted: readonly Trade[]): RollingPoint[] {
  const w = EDGE_DECAY_WINDOW;
  const points: RollingPoint[] = [];
  if (sorted.length < w) return points;
  for (let i = w - 1; i < sorted.length; i++) {
    const window = sorted.slice(i - w + 1, i + 1);
    const profits = window.map(profitDouble);
    const wins = window.filter(isWin);
    const losses = window.filter(isLoss);
    let grossWin = 0;
    for (const t of wins) grossWin += profitDouble(t);
    let lossSum = 0;
    for (const t of losses) lossSum += profitDouble(t);
    const grossLoss = Math.abs(lossSum);
    const winRate = wins.length / window.length;
    const avgWin = wins.length === 0 ? 0 : grossWin / wins.length;
    const avgLoss = losses.length === 0 ? 0 : grossLoss / losses.length;
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 5 : 0;
    const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
    let total = 0;
    for (const p of profits) total += p;
    const mean = total / profits.length;
    let sq = 0;
    for (const p of profits) sq += (p - mean) * (p - mean);
    const stddev = Math.sqrt(sq / profits.length);
    const sharpe = stddev > 0 ? mean / stddev : 0;
    const point: RollingPoint = {
      id: i,
      tradeNumber: i + 1,
      date: (window[window.length - 1] as Trade).closeTime,
      sharpe: clamp(sharpe, -3, 3),
      pf: swiftMin(pf, 5),
      expectancy,
    };
    if (ctx.brand === "dojix") point.volRegime = dominant(window, (t) => (t.brand === "dojix" ? t.volRegime : ""));
    points.push(point);
  }
  return points;
}

function avg(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** The status rule (EdgeDecayMonitor.swift:105-123): last 30 points vs the 30 before them. */
export function edgeDecayStatus(points: readonly RollingPoint[]): DecayStatus {
  const w = EDGE_DECAY_WINDOW;
  if (points.length < 2) return "healthy";
  const recent = points.slice(-w);
  const prior = points.slice(0, Math.max(0, points.length - w)).slice(-w);
  if (prior.length === 0 || recent.length === 0) return "healthy";
  const pfDrop = avg(prior.map((p) => p.pf)) - avg(recent.map((p) => p.pf));
  const priorExp = avg(prior.map((p) => p.expectancy));
  const recentExp = avg(recent.map((p) => p.expectancy));
  const expDropPct = priorExp !== 0 ? (priorExp - recentExp) / Math.abs(priorExp) : 0;
  if (pfDrop > 0.5 || expDropPct > 0.3) return "decaying";
  if (pfDrop > 0.25 || expDropPct > 0.15) return "warning";
  return "healthy";
}

function winRatePct(trades: readonly Trade[]): number {
  return (trades.filter(isWin).length / trades.length) * 100;
}

function diagnosesOf(ctx: EngineContext, sorted: readonly Trade[], status: DecayStatus): DecayDiagnosis[] {
  if (status === "healthy" || sorted.length < EDGE_DECAY_WINDOW * 2) return [];
  const results: DecayDiagnosis[] = [];
  const midpoint = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, midpoint);
  const secondHalf = sorted.slice(midpoint);

  if (ctx.brand === "dojix") {
    const regime = (t: Trade) => (t.brand === "dojix" ? t.volRegime : "");
    const firstDominant = dominant(firstHalf, regime);
    const secondDominant = dominant(secondHalf, regime);
    if (firstDominant !== secondDominant) {
      results.push({
        dimension: "Regime Shift",
        detail: `Volatility shifted from ${firstDominant} to ${secondDominant}`,
        severity: "warning",
      });
    }
  }

  // Dojix: Calendar.current days; Greenwick: ET trading days (ctx.calendar is ET there).
  const days = (half: readonly Trade[]) => new Set(half.map((t) => ctx.calendar.startOfDay(t.closeTime))).size;
  const firstDays = days(firstHalf);
  const secondDays = days(secondHalf);
  const firstFreq = firstDays > 0 ? firstHalf.length / firstDays : 0;
  const secondFreq = secondDays > 0 ? secondHalf.length / secondDays : 0;
  if (secondFreq > firstFreq * 1.3) {
    results.push({
      dimension: "Overtrading",
      detail: swiftFormat("Trade frequency up %.0f%% (%.1f → %.1f/day)", (secondFreq / firstFreq - 1) * 100, firstFreq, secondFreq),
      severity: secondFreq > firstFreq * 1.5 ? "decaying" : "warning",
    });
  }

  const firstSessions = new Set(firstHalf.map((t) => t.session as string));
  const newSessions = [...new Set(secondHalf.map((t) => t.session as string))].filter((s) => !firstSessions.has(s));
  const displayName = (s: string) =>
    ctx.brand === "dojix"
      ? TRADING_SESSION_INFO[s as keyof typeof TRADING_SESSION_INFO].displayName
      : MARKET_SESSION_INFO[s as keyof typeof MARKET_SESSION_INFO].displayName;
  if (newSessions.length > 0) {
    results.push({ dimension: "Strategy Drift", detail: `New sessions: ${newSessions.map(displayName).join(", ")}`, severity: "warning" });
  }

  const sessions: readonly string[] = ctx.brand === "dojix" ? TRADING_SESSIONS : MARKET_SESSIONS;
  for (const session of sessions) {
    const a = firstHalf.filter((t) => t.session === session);
    const b = secondHalf.filter((t) => t.session === session);
    if (a.length < 10 || b.length < 10) continue;
    const firstWR = winRatePct(a);
    const secondWR = winRatePct(b);
    if (firstWR - secondWR > 15) {
      results.push({
        dimension: `${displayName(session)} Decay`,
        detail: swiftFormat("Win rate dropped %.0f%% → %.0f%%", firstWR, secondWR),
        severity: firstWR - secondWR > 25 ? "decaying" : "warning",
      });
    }
  }
  return results;
}

export function computeEdgeDecayMonitor<T extends Trade>(ctx: EngineContext, trades: readonly T[]): EdgeDecayMonitorModel<T> {
  const sorted = sortedByCloseAscending(trades);
  const rollingData = rolling(ctx, sorted);
  const status = edgeDecayStatus(rollingData);
  return {
    sorted,
    rollingData,
    status,
    diagnoses: diagnosesOf(ctx, sorted, status),
    hasEnoughData: sorted.length >= EDGE_DECAY_WINDOW * 2,
  };
}

export const edgeDecayMonitorComponent = defineComponent<BrandId, EdgeDecayMonitorModel>({
  id: "EdgeDecayMonitor",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  // The Mac shows the header and "Need at least 60 trades" below 60.
  minTrades: EDGE_DECAY_WINDOW * 2,
  compute: (ctx, trades) => computeEdgeDecayMonitor(ctx, trades),
});

const refStatus = (s: DecayStatus) => ({ $case: s, ...DECAY_STATUS_INFO[s] });

export const edgeDecayMonitorParity: ComponentParity<EdgeDecayMonitorModel> = {
  component: "EdgeDecayMonitor",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeEdgeDecayMonitor(ctx, trades),
  members: {
    sorted: (m) => toRef(m.sorted),
    // RollingPoint.id is a stored Int, kept by the harness.
    rollingData: (m) => toRef(m.rollingData, { dates: ["date"] }),
    // DecayStatus has no raw value; RefDumpable extras: label, icon.
    status: (m) => refStatus(m.status),
    diagnoses: (m) => m.diagnoses.map((d) => ({ detail: d.detail, dimension: d.dimension, severity: refStatus(d.severity) })),
  },
};
