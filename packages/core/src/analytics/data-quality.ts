// DataQuality (SPEC Appendix A): flags suspicious rows, in the Mac's order.
//
// Port of Dojix `Components/DataQuality.swift:31-80` and Greenwick
// `Components/DataQuality.swift:31-76,131-136`. Checks, each added only when its count > 0:
// 1. R == 0 (warning);
// 2. size > 5 × the average size, with a positive average (warning; lots / shares);
// 3. duration == 0 (info);
// 4. duplicate close times = count − distinct count (warning);
// 5. weekend opens (info): Dojix `Calendar.current` (ctx.calendar), Greenwick
//    `TradingCalendar.isWeekend` (ET, so a Friday-evening trade is not a weekend one);
// 6. MAE > 3 × MFE with MFE > 0 (warning), reported only when the count exceeds n/4
//    (integer division) — this one may be 0 < count ≤ n/4 and still be dropped.
// Unknown MAE/MFE (D-18, `fixed`) are skipped; they could never count anyway (MFE > 0 fails).

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { maeOf, mfeOf, quantity } from "../model/accessors";
import type { Trade } from "../model/trade";
import { idiv } from "../swiftcompat/int";
import type { ComponentParity } from "./support";

export type DataQualitySeverity = "warning" | "info";

/** `Issue.Severity.icon` (DataQuality.swift:16-21). */
export const DATA_QUALITY_SEVERITY_ICON: Readonly<Record<DataQualitySeverity, string>> = {
  warning: "exclamationmark.triangle.fill",
  info: "info.circle.fill",
};

export interface DataQualityIssue {
  severity: DataQualitySeverity;
  message: string;
  count: number;
}

export interface DataQualityModel {
  issues: DataQualityIssue[];
  /** Trades checked (the "across N trades" line). */
  tradeCount: number;
  /** The header's "All clear": no issues and at least one trade. */
  allClear: boolean;
}

export function computeDataQuality(ctx: EngineContext, trades: readonly Trade[]): DataQualityModel {
  const n = trades.length;
  const issues: DataQualityIssue[] = [];
  if (n > 0) {
    const zeroR = trades.filter((t) => t.rMultiple === 0).length;
    if (zeroR > 0) issues.push({ severity: "warning", message: "Trades with missing R-multiple (no SL set?)", count: zeroR });

    let sizeSum = 0;
    for (const t of trades) sizeSum += quantity(t);
    const avg = sizeSum / n;
    const big = trades.filter((t) => quantity(t) > avg * 5 && avg > 0).length;
    if (big > 0) {
      const message = ctx.brand === "dojix" ? "Trades with 5x+ average lot size" : "Trades with 5x+ average position size";
      issues.push({ severity: "warning", message, count: big });
    }

    const zeroDuration = trades.filter((t) => t.durationMin === 0).length;
    if (zeroDuration > 0) issues.push({ severity: "info", message: "Trades with 0-minute duration", count: zeroDuration });

    const dupes = n - new Set(trades.map((t) => t.closeTime)).size;
    if (dupes > 0) issues.push({ severity: "warning", message: "Trades with identical close times", count: dupes });

    // ctx.calendar is the display calendar (Dojix) or the ET trading calendar (Greenwick).
    const weekend = trades.filter((t) => ctx.calendar.isWeekend(t.openTime)).length;
    if (weekend > 0) issues.push({ severity: "info", message: "Trades opened on weekends", count: weekend });

    let bad = 0;
    for (const t of trades) {
      const mae = maeOf(t, ctx.compat);
      const mfe = mfeOf(t, ctx.compat);
      if (mae === null || mfe === null) continue;
      if (mae > mfe * 3 && mfe > 0) bad += 1;
    }
    if (bad > idiv(n, 4)) {
      issues.push({ severity: "warning", message: "Trades with MAE > 3x MFE (entry quality issue)", count: bad });
    }
  }
  return { issues, tradeCount: n, allClear: issues.length === 0 && n > 0 };
}

export const dataQualityComponent = defineComponent<BrandId, DataQualityModel>({
  id: "DataQuality",
  brands: ["dojix", "greenwick"],
  tab: "advanced",
  minTrades: 1,
  compute: (ctx, trades) => computeDataQuality(ctx, trades),
});

export const dataQualityParity: ComponentParity<DataQualityModel> = {
  component: "DataQuality",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeDataQuality(ctx, trades),
  members: {
    // Issue: id (UUID) omitted; Severity has no raw value but exposes `icon` (RefDumpable).
    issues: (m) =>
      m.issues.map((i) => ({
        count: i.count,
        message: i.message,
        severity: { $case: i.severity, icon: DATA_QUALITY_SEVERITY_ICON[i.severity] },
      })),
  },
};
