// Stop distance and R-multiple computed at import time (SPEC §3.3 "generic derived values").

import type { CompatMode, SwiftDecimal } from "@dojix-desktop/core";

function abs(d: SwiftDecimal): SwiftDecimal {
  return d.sign() < 0 ? d.negate() : d;
}

/** Swift `Decimal != 0` (NaN is unequal to everything). */
function nonZero(d: SwiftDecimal): boolean {
  return d.isNaN || !d.isZero;
}

/**
 * Dojix generic CSV (GenericCSVParser.swift:290-299): SL distance in pips (×100 for JPY pairs,
 * ×10000 otherwise) and R = profit / (slDist × lots × pipValue). The Mac's pip value is 100 per
 * lot for JPY pairs and 10 otherwise; `fixed` mode uses 10 for every pair (PARITY D-06).
 */
export function dojixSlDistAndR(
  symbol: string,
  openPrice: SwiftDecimal,
  sl: SwiftDecimal,
  profit: SwiftDecimal,
  lots: number,
  compat: CompatMode,
): { slDistPips: number; rMultiple: number } {
  if (!(nonZero(sl) && nonZero(openPrice))) return { slDistPips: 0, rMultiple: 0 };
  const jpy = symbol.includes("JPY");
  const slDistPips = abs(openPrice.subtract(sl)).toDouble() * (jpy ? 100 : 10000);
  const pipValue = compat === "fixed" ? 10 : jpy ? 100 : 10;
  const rMultiple = slDistPips > 0 ? profit.toDouble() / (slDistPips * lots * pipValue) : 0;
  return { slDistPips, rMultiple };
}

/**
 * Greenwick generic CSV (GenericCSVParser.swift:719-728): SL distance in points and
 * R = net profit / (slDist × shares).
 */
export function greenwickSlDistAndR(
  openPrice: SwiftDecimal,
  sl: SwiftDecimal,
  netProfit: SwiftDecimal,
  shares: number,
): { slDistPoints: number; rMultiple: number } {
  if (!(nonZero(sl) && nonZero(openPrice))) return { slDistPoints: 0, rMultiple: 0 };
  const slDistPoints = abs(openPrice.subtract(sl)).toDouble();
  const rMultiple = slDistPoints > 0 ? netProfit.toDouble() / (slDistPoints * shares) : 0;
  return { slDistPoints, rMultiple };
}
