// ShareableSummary (SPEC Appendix A): a fixed text template for pasting into a chat.
//
// Port of Dojix `Components/ShareableSummary.swift:12-29` and Greenwick
// `Components/ShareableSummary.swift:13-30`; only the app name differs. Empty text when there
// are no trades. Formatting:
// - P&L: "+" when total ≥ 0, then `asCurrency` (which carries its own "-");
// - win rate `asPercent` ("%.1f%"), PF `asProfitFactor` (∞ → "99.99"), expectancy
//   `asCurrency`, avg R `asRMultiple` ("%.2fR"), Sharpe "%.2f";
// - streak: 🔥 n W / ❄️ n L / ➖ 0 (`abs(currentStreak)`).
// Multi-line Swift literal: lines joined by "\n", no trailing newline.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { calculateMetrics, type PortfolioMetrics } from "../metrics/metrics-calculator";
import type { Trade } from "../model/trade";
import { asCurrency, asPercent, asProfitFactor, asRMultiple, swiftFormat } from "../swiftcompat/format";
import type { ComponentParity } from "./support";

export interface ShareableSummaryModel {
  summaryText: string;
}

export interface ShareableSummaryOptions {
  /** The Dashboard's metrics for these trades (computed here when omitted). */
  metrics?: PortfolioMetrics;
}

const APP_NAME: Readonly<Record<BrandId, string>> = { dojix: "Dojix", greenwick: "Greenwick" };
const RULE = "─────────────────────";

export function summaryTextOf(brand: BrandId, m: PortfolioMetrics, locale: string): string {
  if (m.totalTrades <= 0) return "";
  const pnlSign = m.totalProfit >= 0 ? "+" : "";
  const streak = m.currentStreak;
  const icon = streak > 0 ? "🔥" : streak < 0 ? "❄️" : "➖";
  const dir = streak > 0 ? "W" : streak < 0 ? "L" : "";
  const app = APP_NAME[brand];
  return [
    `📊 ${app} Daily Summary`,
    RULE,
    `P&L: ${pnlSign}${asCurrency(m.totalProfit, locale)} | ${m.totalTrades} trades`,
    `Win Rate: ${asPercent(m.winRate)} (${m.wins}W/${m.losses}L)`,
    `PF: ${asProfitFactor(m.profitFactor)} | Exp: ${asCurrency(m.expectancy, locale)}`,
    `Avg R: ${asRMultiple(m.averageRMultiple)} | Sharpe: ${swiftFormat("%.2f", m.sharpeRatio)}`,
    `Streak: ${icon} ${Math.abs(streak)}${dir}`,
    RULE,
    `via ${app}`,
  ].join("\n");
}

export function computeShareableSummary(
  ctx: EngineContext,
  trades: readonly Trade[],
  options: ShareableSummaryOptions = {},
): ShareableSummaryModel {
  return { summaryText: summaryTextOf(ctx.brand, options.metrics ?? calculateMetrics(trades, ctx), ctx.locale) };
}

export const shareableSummaryComponent = defineComponent<BrandId, ShareableSummaryModel>({
  id: "ShareableSummary",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  minTrades: 1,
  compute: (ctx, trades) => computeShareableSummary(ctx, trades),
});

export const shareableSummaryParity: ComponentParity<ShareableSummaryModel> = {
  component: "ShareableSummary",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeShareableSummary(ctx, trades),
  members: { summaryText: (m) => m.summaryText },
};
