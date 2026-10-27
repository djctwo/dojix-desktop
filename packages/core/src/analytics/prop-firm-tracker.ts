// PropFirmTracker / PropFirmStatusBadge (SPEC Appendix A): prop-firm challenge progress.
//
// Port of Dojix `Components/PropFirmTracker.swift:24-76` and Greenwick
// `Components/PropFirmTracker.swift:21-83, 351-363` plus Greenwick
// `Components/PropFirmStatusBadge.swift:13-94` (the compact Overview badge, Greenwick only).
//
// - Settings: account 100,000, target 8 %, daily loss 5 %, total drawdown 10 % (the view's
//   @State defaults, Dojix `PropFirmTracker.swift:10-13`; Greenwick `PropFirmSettings()`).
//   The desktop loads them from the journal and passes them as options.
// - balance = account + Σp (input order); daily = P&L of trades closed "today":
//   Dojix `Calendar.current.startOfDay` of the close vs of now (ctx.calendar, ctx.now);
//   Greenwick the ET trading day of `now` (`TradingCalendar.pnl(onTradingDayOf:)`).
// - maxDrawdown walks ASC with `if cumulative > peak` / `if dd > maxDD` (not `max()`), so a NaN
//   P&L never becomes the peak (it would with Swift's `max`).
// - Breaches: daily loss `abs(daily) > account×daily% && daily < 0`; DD `maxDD > account×DD%`.
// - Greenwick warnings: dailyLossUsed = min(|min(daily, 0)| / dailyLimit$, 1); ≥ .75 caution,
//   ≥ .90 danger, breached wins (`PropFirmStatusBadge.swift:79-84`, tracker header 111-126).
// - Trading days: distinct close days (Dojix display calendar; Greenwick ET trading days).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { profitDouble } from "../model/accessors";
import type { GreenwickTrade, Trade } from "../model/trade";
import { swiftMax, swiftMin } from "../swiftcompat/collections";
import { etTradingDayCount, pnlOnTradingDayOf } from "../time/us-market";
import { clamp, sumProfit, type ComponentParity } from "./support";

export interface PropFirmSettings {
  accountSize: number;
  /** Percent of the account. */
  profitTarget: number;
  /** Percent of the account. */
  maxDailyLoss: number;
  /** Percent of the account. */
  maxTotalDrawdown: number;
}

/** The Mac defaults (`PropFirmSettings()` / the tracker's @State values). */
export const DEFAULT_PROP_FIRM_SETTINGS: Readonly<PropFirmSettings> = Object.freeze({
  accountSize: 100_000,
  profitTarget: 8,
  maxDailyLoss: 5,
  maxTotalDrawdown: 10,
});

/** The harness's extra instance `PropFirmTracker[custom]` (tools/swift-ref/prepare.mjs). */
const CUSTOM_INSTANCE: Readonly<PropFirmSettings> = Object.freeze({
  accountSize: 50_000,
  profitTarget: 10,
  maxDailyLoss: 4,
  maxTotalDrawdown: 8,
});

export type PropFirmWarning = "none" | "caution" | "danger" | "breached";

export interface PropFirmTrackerModel {
  settings: PropFirmSettings;
  totalPnL: number;
  currentBalance: number;
  profitTargetDollars: number;
  maxDailyLossDollars: number;
  maxDrawdownDollars: number;
  /** Today's P&L (brand calendar day of `ctx.now`). */
  dailyPnL: number;
  /** Dollars, ≥ 0. */
  maxDrawdown: number;
  dailyLossBreached: boolean;
  drawdownBreached: boolean;
  tradingDays: number;
  /** Greenwick member (computed for both brands): share of the daily limit used, 0–1. */
  dailyLossUsedPercent: number;
  /** Header badge: Dojix shows only "breached"/"none"; Greenwick also "danger"/"caution". */
  status: PropFirmWarning;
  /** Progress bars (`progressRow`): clamp(current / target, 0, 1), 0 when the target ≤ 0. */
  profitProgress: number;
  dailyLossProgress: number;
  drawdownProgress: number;
}

/** `maxDrawdown` exactly as both trackers and the badge write it (comparisons, not `max`). */
export function propFirmMaxDrawdown(trades: readonly Trade[]): number {
  let peak = 0;
  let maxDD = 0;
  let cumulative = 0;
  for (const t of sortedByCloseAscending(trades)) {
    cumulative += profitDouble(t);
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/** Today's P&L on the brand calendar (Dojix `PropFirmTracker.swift:44-49`; Greenwick 351-356). */
export function propFirmTodayPnL(ctx: EngineContext, trades: readonly Trade[]): number {
  if (ctx.brand === "greenwick") return pnlOnTradingDayOf(ctx.now, trades as readonly GreenwickTrade[]);
  const today = ctx.calendar.startOfDay(ctx.now);
  let total = 0;
  for (const t of trades) if (ctx.calendar.startOfDay(t.closeTime) === today) total += profitDouble(t);
  return total;
}

function tradingDayCountOf(ctx: EngineContext, trades: readonly Trade[]): number {
  if (ctx.brand === "greenwick") return etTradingDayCount(trades);
  return new Set(trades.map((t) => ctx.calendar.startOfDay(t.closeTime))).size;
}

function progress(current: number, target: number): number {
  return target > 0 ? clamp(current / target, 0, 1) : 0;
}

/** `dailyLossUsed` (badge) / `dailyLossUsedPercent` (Greenwick tracker). */
function dailyLossUsedOf(dailyPnL: number, maxDailyLossDollars: number): number {
  if (!(maxDailyLossDollars > 0)) return 0;
  return swiftMin(Math.abs(swiftMin(dailyPnL, 0)) / maxDailyLossDollars, 1);
}

function warningOf(dailyLossBreached: boolean, used: number): PropFirmWarning {
  if (dailyLossBreached) return "breached";
  if (used >= 0.9) return "danger";
  if (used >= 0.75) return "caution";
  return "none";
}

export function computePropFirmTracker(
  ctx: EngineContext,
  trades: readonly Trade[],
  settings: PropFirmSettings = DEFAULT_PROP_FIRM_SETTINGS,
): PropFirmTrackerModel {
  const { accountSize } = settings;
  const totalPnL = sumProfit(trades);
  const profitTargetDollars = accountSize * (settings.profitTarget / 100);
  const maxDailyLossDollars = accountSize * (settings.maxDailyLoss / 100);
  const maxDrawdownDollars = accountSize * (settings.maxTotalDrawdown / 100);
  const dailyPnL = propFirmTodayPnL(ctx, trades);
  const maxDrawdown = propFirmMaxDrawdown(trades);
  const dailyLossBreached = Math.abs(dailyPnL) > maxDailyLossDollars && dailyPnL < 0;
  const drawdownBreached = maxDrawdown > maxDrawdownDollars;
  const dailyLossUsedPercent = dailyLossUsedOf(dailyPnL, maxDailyLossDollars);
  let status: PropFirmWarning;
  if (dailyLossBreached || drawdownBreached) status = "breached";
  else if (ctx.brand === "greenwick") status = warningOf(false, dailyLossUsedPercent);
  else status = "none";
  return {
    settings: { ...settings },
    totalPnL,
    currentBalance: accountSize + totalPnL,
    profitTargetDollars,
    maxDailyLossDollars,
    maxDrawdownDollars,
    dailyPnL,
    maxDrawdown,
    dailyLossBreached,
    drawdownBreached,
    tradingDays: tradingDayCountOf(ctx, trades),
    dailyLossUsedPercent,
    status,
    profitProgress: progress(swiftMax(totalPnL, 0), profitTargetDollars),
    dailyLossProgress: progress(Math.abs(swiftMin(dailyPnL, 0)), maxDailyLossDollars),
    drawdownProgress: progress(maxDrawdown, maxDrawdownDollars),
  };
}

export interface PropFirmStatusBadgeModel {
  accountSize: number;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  profitTargetPercent: number;
  totalPnL: number;
  dailyPnL: number;
  maxDailyLossDollars: number;
  maxDrawdownDollars: number;
  profitTargetDollars: number;
  maxDrawdown: number;
  dailyLossBreached: boolean;
  drawdownBreached: boolean;
  isBreached: boolean;
  /** 0–1. */
  profitProgress: number;
  /** 0–1. */
  dailyLossUsed: number;
  dailyLossWarning: PropFirmWarning;
  /** The badge text: BREACHED / DANGER / CAUTION / ON TRACK (`PropFirmStatusBadge.swift:114-127`). */
  statusLabel: "BREACHED" | "DANGER" | "CAUTION" | "ON TRACK";
}

/** Greenwick `PropFirmStatusBadge` (Overview). */
export function computePropFirmStatusBadge(
  ctx: EngineContext,
  trades: readonly Trade[],
  settings: PropFirmSettings = DEFAULT_PROP_FIRM_SETTINGS,
): PropFirmStatusBadgeModel {
  const accountSize = settings.accountSize;
  const totalPnL = sumProfit(trades);
  const dailyPnL = propFirmTodayPnL(ctx, trades);
  const maxDailyLossDollars = accountSize * (settings.maxDailyLoss / 100);
  const maxDrawdownDollars = accountSize * (settings.maxTotalDrawdown / 100);
  const profitTargetDollars = accountSize * (settings.profitTarget / 100);
  const maxDrawdown = propFirmMaxDrawdown(trades);
  const dailyLossBreached = Math.abs(dailyPnL) > maxDailyLossDollars && dailyPnL < 0;
  const drawdownBreached = maxDrawdown > maxDrawdownDollars;
  const dailyLossUsed = dailyLossUsedOf(dailyPnL, maxDailyLossDollars);
  const dailyLossWarning = warningOf(dailyLossBreached, dailyLossUsed);
  const statusLabel =
    dailyLossWarning === "breached"
      ? "BREACHED"
      : dailyLossWarning === "danger"
        ? "DANGER"
        : dailyLossWarning === "caution"
          ? "CAUTION"
          : drawdownBreached
            ? "BREACHED"
            : "ON TRACK";
  return {
    accountSize,
    maxDailyLossPercent: settings.maxDailyLoss,
    maxDrawdownPercent: settings.maxTotalDrawdown,
    profitTargetPercent: settings.profitTarget,
    totalPnL,
    dailyPnL,
    maxDailyLossDollars,
    maxDrawdownDollars,
    profitTargetDollars,
    maxDrawdown,
    dailyLossBreached,
    drawdownBreached,
    isBreached: dailyLossBreached || drawdownBreached,
    profitProgress: profitTargetDollars > 0 ? clamp(totalPnL / profitTargetDollars, 0, 1) : 0,
    dailyLossUsed,
    dailyLossWarning,
    statusLabel,
  };
}

export const propFirmTrackerComponent = defineComponent<BrandId, PropFirmTrackerModel>({
  id: "PropFirmTracker",
  brands: ["dojix", "greenwick"],
  tab: "propFirm",
  minTrades: 0,
  compute: (ctx, trades) => computePropFirmTracker(ctx, trades),
});

/** The Greenwick Overview badge; hidden when there are no trades (`PropFirmStatusBadge.swift:98`). */
export const propFirmStatusBadgeComponent = defineComponent<"greenwick", PropFirmStatusBadgeModel>({
  id: "PropFirmStatusBadge",
  brands: ["greenwick"],
  tab: "overview",
  minTrades: 1,
  compute: (ctx, trades) => computePropFirmStatusBadge(ctx, trades),
});

const plain = <M>(field: keyof M) => (m: M) => m[field];

export const propFirmTrackerParity: ComponentParity<PropFirmTrackerModel> = {
  component: "PropFirmTracker",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades, instance) => {
    if (instance === undefined) return computePropFirmTracker(ctx, trades);
    if (instance === "custom") return computePropFirmTracker(ctx, trades, CUSTOM_INSTANCE);
    return undefined;
  },
  members: Object.fromEntries(
    (
      [
        "totalPnL",
        "currentBalance",
        "profitTargetDollars",
        "maxDailyLossDollars",
        "maxDrawdownDollars",
        "dailyPnL",
        "maxDrawdown",
        "dailyLossBreached",
        "dailyLossUsedPercent",
        "drawdownBreached",
        "tradingDays",
      ] as const
    ).map((k) => [k, plain<PropFirmTrackerModel>(k)]),
  ),
  integerMembers: ["tradingDays"],
};

export const propFirmStatusBadgeParity: ComponentParity<PropFirmStatusBadgeModel> = {
  component: "PropFirmStatusBadge",
  brands: ["greenwick"],
  compute: (ctx, trades, instance) => (instance === undefined ? computePropFirmStatusBadge(ctx, trades) : undefined),
  members: Object.fromEntries(
    (
      [
        "accountSize",
        "maxDailyLossPercent",
        "maxDrawdownPercent",
        "profitTargetPercent",
        "totalPnL",
        "dailyPnL",
        "maxDailyLossDollars",
        "maxDrawdownDollars",
        "profitTargetDollars",
        "maxDrawdown",
        "dailyLossBreached",
        "drawdownBreached",
        "isBreached",
        "profitProgress",
        "dailyLossUsed",
        // A private enum without raw value: the harness writes the case name.
        "dailyLossWarning",
      ] as const
    ).map((k) => [k, plain<PropFirmStatusBadgeModel>(k)]),
  ),
};
