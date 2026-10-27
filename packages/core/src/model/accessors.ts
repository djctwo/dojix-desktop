// Derived per-trade values, matching the Mac `extension Trade` computed properties
// (Dojix `Models/Trade.swift:207-313`, Greenwick `Models/Trade.swift:194-283`), plus
// brand-neutral accessors so shared components can be written once.

import { decimalToDouble, SwiftDecimal } from "../swiftcompat/decimal";
import { swiftMax, swiftMin } from "../swiftcompat/collections";
import { swiftPrefix, swiftSuffix } from "../swiftcompat/strings";
import type { CompatMode } from "../engine/compat";
import type { DojixTrade, GreenwickTrade, Trade } from "./trade";
import { parseTradeEmotion, type TradeEmotion } from "./enums";

interface MoneyCache {
  profit: number;
  profitSign: number;
  commission: number;
  swap: number;
}

const cache = new WeakMap<Trade, MoneyCache>();

function money(t: Trade): MoneyCache {
  let m = cache.get(t);
  if (!m) {
    const p = SwiftDecimal.parse(t.netProfit);
    m = {
      profit: p === null ? NaN : p.toDouble(),
      profitSign: p === null ? NaN : p.sign(),
      commission: decimalToDouble(t.commission),
      swap: decimalToDouble(t.swap),
    };
    cache.set(t, m);
  }
  return m;
}

/** `Trade.profitDouble`: net P&L as the Mac converts it (Foundation Decimal → Double). */
export function profitDouble(t: Trade): number {
  return money(t).profit;
}

/** `Trade.isWin`: `netProfit > 0`, compared in Decimal. */
export function isWin(t: Trade): boolean {
  return money(t).profitSign > 0;
}

/** `Trade.isLoss`: `netProfit < 0`, compared in Decimal. */
export function isLoss(t: Trade): boolean {
  return money(t).profitSign < 0;
}

/** Neither a win nor a loss (P&L exactly zero). Still counts in win-rate denominators. */
export function isBreakeven(t: Trade): boolean {
  return money(t).profitSign === 0;
}

/** `Trade.commissionDouble`. */
export function commissionDouble(t: Trade): number {
  return money(t).commission;
}

/** `Trade.swapDouble`. */
export function swapDouble(t: Trade): number {
  return money(t).swap;
}

/** `Trade.totalCosts` = commissionDouble + swapDouble. */
export function totalCosts(t: Trade): number {
  const m = money(t);
  return m.commission + m.swap;
}

/**
 * Dojix `Trade.netProfitAfterCosts` (Decimal `netProfit − commission − swap`) as a Double.
 * Informational on Dojix: MT5 P&L already includes the costs (SPEC §3.1).
 */
export function netProfitAfterCostsDouble(t: DojixTrade): number {
  const n = SwiftDecimal.parse(t.netProfit);
  const c = SwiftDecimal.parse(t.commission);
  const s = SwiftDecimal.parse(t.swap);
  if (n === null || c === null || s === null) return NaN;
  return n.subtract(c).subtract(s).toDouble();
}

/** Greenwick `Trade.grossProfitBeforeCosts` (Decimal `netProfit + commission + swap`) as a Double. */
export function grossProfitBeforeCostsDouble(t: GreenwickTrade): number {
  const n = SwiftDecimal.parse(t.netProfit);
  const c = SwiftDecimal.parse(t.commission);
  const s = SwiftDecimal.parse(t.swap);
  if (n === null || c === null || s === null) return NaN;
  return n.add(c).add(s).toDouble();
}

// --- brand-neutral accessors -----------------------------------------------------------------

/** Position size: lots (Dojix) or shares (Greenwick). */
export function quantity(t: Trade): number {
  return t.brand === "dojix" ? t.lots : t.shares;
}

/** Raw MAE (pips / points), null when unknown. */
export function maeRaw(t: Trade): number | null {
  return t.brand === "dojix" ? t.maePips : t.maePoints;
}

/** Raw MFE (pips / points), null when unknown. */
export function mfeRaw(t: Trade): number | null {
  return t.brand === "dojix" ? t.mfePips : t.mfePoints;
}

/**
 * MAE as a component should read it: in `swift` compat an unknown MAE is 0 (the Mac stores
 * 0); in `fixed` mode it stays null and the caller must skip it (D-18).
 */
export function maeOf(t: Trade, compat: CompatMode): number | null {
  const v = maeRaw(t);
  return v === null && compat === "swift" ? 0 : v;
}

/** MFE; see `maeOf`. */
export function mfeOf(t: Trade, compat: CompatMode): number | null {
  const v = mfeRaw(t);
  return v === null && compat === "swift" ? 0 : v;
}

/** Stop distance: pips (Dojix) or points (Greenwick). */
export function slDist(t: Trade): number {
  return t.brand === "dojix" ? t.slDistPips : t.slDistPoints;
}

/** Slippage: pips (Dojix) or points (Greenwick). */
export function slippage(t: Trade): number {
  return t.brand === "dojix" ? t.slippagePips : t.slippagePoints;
}

/** Session raw value (TradingSession for Dojix, MarketSession for Greenwick). */
export function sessionRaw(t: Trade): string {
  return t.session;
}

/**
 * `Trade.exitEfficiency`: share of the MFE captured, 0–100, or null when MFE or the stop
 * distance is not positive (unknown MFE gives null in both compat modes).
 */
export function exitEfficiency(t: Trade, compat: CompatMode): number | null {
  const mfe = mfeOf(t, compat);
  const sl = slDist(t);
  if (mfe === null || !(mfe > 0) || !(sl > 0)) return null;
  const captured = t.rMultiple * sl;
  return swiftMin(swiftMax((captured / mfe) * 100, 0), 100);
}

/** `Trade.moneyLeftOnTable`: MFE minus captured move, for winners with a positive MFE. */
export function moneyLeftOnTable(t: Trade, compat: CompatMode): number | null {
  const mfe = mfeOf(t, compat);
  if (mfe === null || !(mfe > 0) || !isWin(t)) return null;
  const captured = t.rMultiple * slDist(t);
  return swiftMax(mfe - captured, 0);
}

/** `Trade.tradeEmotion`. */
export function tradeEmotion(t: Trade): TradeEmotion | null {
  return parseTradeEmotion(t.emotion);
}

/** Dojix `baseCurrency`: the first 3 Characters of the symbol. */
export function baseCurrency(t: DojixTrade): string {
  return swiftPrefix(t.symbol, 3);
}

/** Dojix `quoteCurrency`: the last 3 Characters of the symbol. */
export function quoteCurrency(t: DojixTrade): string {
  return swiftSuffix(t.symbol, 3);
}

/** Dojix `pairDisplay`: "EUR/USD". */
export function pairDisplay(t: DojixTrade): string {
  return `${baseCurrency(t)}/${quoteCurrency(t)}`;
}
