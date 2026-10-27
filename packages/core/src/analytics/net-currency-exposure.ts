// NetCurrencyExposure (SPEC Appendix A, Dojix only): net lots per currency.
//
// Port of Dojix `Components/NetCurrencyExposure.swift:10-77, 90-99, 151-177`.
//
// - Each trade adds ±lots (BUY +, SELL −) to its base currency (first 3 Characters of the
//   symbol) and the opposite to its quote currency (last 3).
// - exposures sorted by |net| descending (stable). The Mac builds them from a dictionary, so
//   equal |net| come out in random order; the desktop keeps first-appearance order.
// - maxAbsExposure = max |net| (1 when there are none); totalAbsExposure = max(Σ|net|, 1).
// - concentration = (top currency, |top| / total × 100), ("--", 0) when empty;
//   > 50 warning (orange), > 70 red — unreachable, since the nets sum to 0 (top ≤ 50 %).
// - correlatedInsights: per currency with ≥ 2 distinct pairs, per direction ("long", "short")
//   with ≥ 2 distinct pairs on that side: the pairs sorted; all insights sorted by the
//   currency's |net| descending (stable). Dictionary order again → first appearance.
// - The view needs n ≥ 5 (`NetCurrencyExposure.swift:90`).

import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { baseCurrency, quoteCurrency } from "../model/accessors";
import type { DojixTrade } from "../model/trade";
import { seqMax, stableSorted, swiftMax } from "../swiftcompat/collections";
import { formatFixed, swiftFormat } from "../swiftcompat/format";
import { swiftPrefix, swiftSuffix } from "../swiftcompat/strings";
import { type ComponentParity } from "./support";

export interface CurrencyExposure {
  currency: string;
  netLots: number;
}

export interface CorrelatedInsight {
  currency: string;
  direction: "long" | "short";
  /** Distinct symbols, sorted. */
  pairs: string[];
}

export interface NetCurrencyExposureModel {
  exposures: CurrencyExposure[];
  maxAbsExposure: number;
  totalAbsExposure: number;
  concentration: { currency: string; percent: number };
  correlatedInsights: CorrelatedInsight[];
  /** "none" ≤ 50, "warning" > 50, "danger" > 70. */
  concentrationLevel: "none" | "warning" | "danger";
  /** "62% of your volume is USD-denominated". */
  concentrationText: string;
  /** Up to 3 lines: "2x long EUR via EUR/USD + EUR/JPY". */
  insightLines: string[];
  /** Per exposure: "%+.2f" text. */
  netLotsText: string[];
}

/**
 * The concentration colour (`NetCurrencyExposure.swift:49-53`). Note: every trade adds +lots to
 * one currency and −lots to another, so the top currency never holds more than half of
 * Σ|net| and the Mac never shows these levels; kept for fidelity.
 */
export function concentrationLevelOf(percent: number): "none" | "warning" | "danger" {
  return percent > 70 ? "danger" : percent > 50 ? "warning" : "none";
}

export function computeNetCurrencyExposure(_ctx: EngineContext, trades: readonly DojixTrade[]): NetCurrencyExposureModel {
  const map = new Map<string, number>();
  const add = (k: string, v: number) => map.set(k, (map.get(k) ?? 0) + v);
  const sub = (k: string, v: number) => map.set(k, (map.get(k) ?? 0) - v);
  for (const t of trades) {
    const sign = t.direction === "BUY" ? 1 : -1;
    add(baseCurrency(t), sign * t.lots);
    sub(quoteCurrency(t), sign * t.lots);
  }
  const exposures = stableSorted(
    [...map].map(([currency, netLots]) => ({ currency, netLots })),
    (a, b) => Math.abs(a.netLots) > Math.abs(b.netLots),
  );
  const abs = exposures.map((e) => Math.abs(e.netLots));
  const maxAbsExposure = seqMax(abs) ?? 1;
  let sumAbs = 0;
  for (const a of abs) sumAbs += a;
  const totalAbsExposure = swiftMax(sumAbs, 1);
  const top = exposures[0];
  const concentration = top
    ? { currency: top.currency, percent: (Math.abs(top.netLots) / totalAbsExposure) * 100 }
    : { currency: "--", percent: 0 };

  // correlatedInsights
  const currencyPairs = new Map<string, { pair: string; dir: "long" | "short" }[]>();
  const push = (k: string, e: { pair: string; dir: "long" | "short" }) => {
    const list = currencyPairs.get(k);
    if (list) list.push(e);
    else currencyPairs.set(k, [e]);
  };
  for (const t of trades) {
    const baseDir = t.direction === "BUY" ? "long" : "short";
    const quoteDir = t.direction === "BUY" ? "short" : "long";
    push(baseCurrency(t), { pair: t.symbol, dir: baseDir });
    push(quoteCurrency(t), { pair: t.symbol, dir: quoteDir });
  }
  const results: CorrelatedInsight[] = [];
  for (const [currency, entries] of currencyPairs) {
    if (new Set(entries.map((e) => e.pair)).size < 2) continue;
    for (const dir of ["long", "short"] as const) {
      const pairs = new Set(entries.filter((e) => e.dir === dir).map((e) => e.pair));
      if (pairs.size < 2) continue;
      results.push({ currency, direction: dir, pairs: [...pairs].sort() });
    }
  }
  const lotsFor = (c: string) => exposures.find((e) => e.currency === c)?.netLots ?? 0;
  const correlatedInsights = stableSorted(results, (a, b) => Math.abs(lotsFor(a.currency)) > Math.abs(lotsFor(b.currency)));

  return {
    exposures,
    maxAbsExposure,
    totalAbsExposure,
    concentration,
    correlatedInsights,
    concentrationLevel: concentrationLevelOf(concentration.percent),
    concentrationText: `${formatFixed(concentration.percent, 0)}% of your volume is ${concentration.currency}-denominated`,
    insightLines: correlatedInsights.slice(0, 3).map((i) => {
      const pairs = i.pairs.map((p) => `${swiftPrefix(p, 3)}/${swiftSuffix(p, 3)}`);
      return `${i.pairs.length}x ${i.direction} ${i.currency} via ${pairs.join(" + ")}`;
    }),
    netLotsText: exposures.map((e) => swiftFormat("%+.2f", e.netLots)),
  };
}

export const netCurrencyExposureComponent = defineComponent<"dojix", NetCurrencyExposureModel>({
  id: "NetCurrencyExposure",
  brands: ["dojix"],
  tab: "risk",
  minTrades: 5,
  compute: (ctx, trades) => computeNetCurrencyExposure(ctx, trades),
});

export const netCurrencyExposureParity: ComponentParity<NetCurrencyExposureModel> = {
  component: "NetCurrencyExposure",
  brands: ["dojix"],
  compute: (ctx, trades, instance) =>
    instance === undefined ? computeNetCurrencyExposure(ctx, trades as readonly DojixTrade[]) : undefined,
  members: {
    exposures: (m) => m.exposures.map((e) => ({ currency: e.currency, netLots: e.netLots })),
    maxAbsExposure: (m) => m.maxAbsExposure,
    totalAbsExposure: (m) => m.totalAbsExposure,
    concentration: (m) => ({ currency: m.concentration.currency, percent: m.concentration.percent }),
    correlatedInsights: (m) => m.correlatedInsights.map((i) => ({ currency: i.currency, direction: i.direction, pairs: [...i.pairs] })),
  },
};
