// PositionSizer (SPEC Appendix A): suggested position size for a balance and risk %.
//
// Port of Dojix `Components/PositionSizer.swift:8-47` (lots) and Greenwick
// `Components/PositionSizer.swift:8-46` (shares).
// - balance = `Double(accountBalance) ?? 10_000` (the text field; default "10000");
//   riskPercent defaults to 1.0 (slider 0.25–5, step 0.25); risk = balance × r / 100.
// - Average stop = mean of the positive stop distances, 20 when there are none (both brands).
// - Dojix: lots = risk / (avgSL × 10) (0.10 per micro-lot × 100); `guard avgSL > 0 else 0.01`.
//   Greenwick: shares = risk / (avgSL × 1); `guard avgSL > 0 else 1`. Both are rounded to
//   0.01 with `(x × 100).rounded() / 100`, half away from zero.
// - Aligned when the current average size is 0, or 0.5 ≤ suggested / current ≤ 2.
// The harness also reads the instance `PositionSizer[balance25k_risk2]` (balance "25000", 2%).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { quantity, slDist } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftRounded } from "../swiftcompat/rounding";
import type { ComponentParity } from "./support";

export interface PositionSizerOptions {
  /** The balance text field, parsed like Swift `Double(String)`. Default "10000". */
  accountBalance?: string;
  /** Percent, default 1.0. */
  riskPercent?: number;
}

interface PositionSizerCommon {
  balance: number;
  riskPerTrade: number;
  isSizingAligned: boolean;
  riskPercent: number;
  /** Brand-neutral copies for the UI: pips / points, lots / shares. */
  avgSL: number;
  suggestedSize: number;
  currentAvgSize: number;
}

export interface DojixPositionSizerModel extends PositionSizerCommon {
  brand: "dojix";
  avgSLPips: number;
  suggestedLots: number;
  currentAvgLots: number;
}

export interface GreenwickPositionSizerModel extends PositionSizerCommon {
  brand: "greenwick";
  avgSLPoints: number;
  suggestedShares: number;
  currentAvgShares: number;
}

export type PositionSizerModel = DojixPositionSizerModel | GreenwickPositionSizerModel;

const SWIFT_DOUBLE = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;

/**
 * Swift `Double(String)` for decimal text: the whole string must parse (no spaces), with an
 * optional sign, digits with an optional fraction and exponent, or inf / infinity / nan.
 * (Hexadecimal floats, also accepted by Swift, are not needed for a balance field and read as nil.)
 */
export function parseSwiftDouble(text: string): number | null {
  if (!SWIFT_DOUBLE.test(text)) return null;
  const body = text.replace(/^[+-]/, "").toLowerCase();
  const negative = text.startsWith("-");
  if (body === "nan") return NaN;
  if (body === "inf" || body === "infinity") return negative ? -Infinity : Infinity;
  return Number(text);
}

export function computePositionSizer(
  ctx: EngineContext,
  trades: readonly Trade[],
  options: PositionSizerOptions = {},
): PositionSizerModel {
  const riskPercent = options.riskPercent ?? 1.0;
  const balance = parseSwiftDouble(options.accountBalance ?? "10000") ?? 10_000;
  const riskPerTrade = balance * (riskPercent / 100);

  let slSum = 0;
  let slCount = 0;
  for (const t of trades) {
    const d = slDist(t);
    if (d > 0) {
      slSum += d;
      slCount += 1;
    }
  }
  const avgSL = slCount === 0 ? 20 : slSum / slCount;

  let suggested: number;
  if (ctx.brand === "dojix") {
    suggested = avgSL > 0 ? swiftRounded((riskPerTrade / (avgSL * (0.1 * 100))) * 100) / 100 : 0.01;
  } else {
    suggested = avgSL > 0 ? swiftRounded((riskPerTrade / (avgSL * 1.0)) * 100) / 100 : 1;
  }

  let sizeSum = 0;
  for (const t of trades) sizeSum += quantity(t);
  const currentAvg = trades.length === 0 ? 0 : sizeSum / trades.length;
  const ratio = suggested / currentAvg;
  const isSizingAligned = !(currentAvg > 0) || (ratio >= 0.5 && ratio <= 2.0);

  const common = { balance, riskPerTrade, isSizingAligned, riskPercent, avgSL, suggestedSize: suggested, currentAvgSize: currentAvg };
  return ctx.brand === "dojix"
    ? { brand: "dojix", ...common, avgSLPips: avgSL, suggestedLots: suggested, currentAvgLots: currentAvg }
    : { brand: "greenwick", ...common, avgSLPoints: avgSL, suggestedShares: suggested, currentAvgShares: currentAvg };
}

export const positionSizerComponent = defineComponent<BrandId, PositionSizerModel>({
  id: "PositionSizer",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 0,
  compute: (ctx, trades) => computePositionSizer(ctx, trades),
});

/** prepare.mjs EXTRA_INSTANCES: `balance25k_risk2` = balance "25000", risk 2%. */
const INSTANCES: Readonly<Record<string, PositionSizerOptions>> = {
  balance25k_risk2: { accountBalance: "25000", riskPercent: 2.0 },
};

export const positionSizerParity: ComponentParity<PositionSizerModel> = {
  component: "PositionSizer",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades, instance) => {
    if (instance === undefined) return computePositionSizer(ctx, trades);
    const opts = INSTANCES[instance];
    return opts ? computePositionSizer(ctx, trades, opts) : undefined;
  },
  members: {
    balance: (m) => m.balance,
    riskPerTrade: (m) => m.riskPerTrade,
    avgSLPips: (m) => (m.brand === "dojix" ? m.avgSLPips : undefined),
    suggestedLots: (m) => (m.brand === "dojix" ? m.suggestedLots : undefined),
    currentAvgLots: (m) => (m.brand === "dojix" ? m.currentAvgLots : undefined),
    avgSLPoints: (m) => (m.brand === "greenwick" ? m.avgSLPoints : undefined),
    suggestedShares: (m) => (m.brand === "greenwick" ? m.suggestedShares : undefined),
    currentAvgShares: (m) => (m.brand === "greenwick" ? m.currentAvgShares : undefined),
    isSizingAligned: (m) => m.isSizingAligned,
  },
};
