// Dojix storage hygiene: `Trade+Sanitize.swift` (clamp on import, reject on restore).

import { SwiftDecimal, swiftPrefix, swiftCount, trimSwiftWhitespaces, utcHour, utcShortDayName } from "@dojix-desktop/core";
import type { DojixMacTrade } from "../model";
import { isFoundationControl, stripFoundationControls } from "../swift/text";
import { isValidDojixScreenshotName, screenshotList } from "../screenshots";

/** Trade+Sanitize.swift:11-22. */
export const DOJIX_LIMITS = Object.freeze({
  metricLimit: 1_000_000_000,
  moneyLimit: SwiftDecimal.fromInteger(1_000_000_000_000),
  durationLimit: 10 * 366 * 24 * 60,
  maximumLots: 1_000_000,
  minimumLots: 0.000_01,
  symbolMaxLength: 32,
  commentMaxLength: 256,
});

const VALID_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** Trade+Sanitize.swift:129-131. */
function metric(v: number): number {
  return Math.min(Math.max(finite(v), -DOJIX_LIMITS.metricLimit), DOJIX_LIMITS.metricLimit);
}

/** Trade+Sanitize.swift:120-123. */
export function dojixLotSize(v: number): number {
  const size = Math.min(Math.abs(finite(v)), DOJIX_LIMITS.maximumLots);
  return size > 0 && size < DOJIX_LIMITS.minimumLots ? DOJIX_LIMITS.minimumLots : size;
}

/** Trade+Sanitize.swift:135-138: NaN → 0, clamped to ±1e12. */
export function dojixMoney(v: SwiftDecimal): SwiftDecimal {
  if (v.isNaN) return SwiftDecimal.zero;
  const limit = DOJIX_LIMITS.moneyLimit;
  if (v.compare(limit) > 0) return limit;
  if (v.compare(limit.negate()) < 0) return limit.negate();
  return v;
}

/** Trade+Sanitize.swift:140-143: control characters removed, `.whitespaces` trimmed, then the first N Characters. */
function clean(value: string, maxLength: number): string {
  return swiftPrefix(trimSwiftWhitespaces(stripFoundationControls(value, false)), maxLength);
}

function clampInt(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

/** `Trade.sanitizedForStorage()` (Trade+Sanitize.swift:27-64). */
export function sanitizeDojix(trade: DojixMacTrade): DojixMacTrade {
  const t: DojixMacTrade = { ...trade };
  t.symbol = clean(trade.symbol, DOJIX_LIMITS.symbolMaxLength);
  t.comment = clean(trade.comment, DOJIX_LIMITS.commentMaxLength);
  t.lots = dojixLotSize(trade.lots);
  t.openPrice = dojixMoney(trade.openPrice);
  t.closePrice = dojixMoney(trade.closePrice);
  t.sl = dojixMoney(trade.sl);
  t.tp = dojixMoney(trade.tp);
  t.netProfit = dojixMoney(trade.netProfit);
  t.commission = dojixMoney(trade.commission);
  t.swap = dojixMoney(trade.swap);
  t.maePips = metric(trade.maePips);
  t.mfePips = metric(trade.mfePips);
  t.rMultiple = metric(trade.rMultiple);
  t.rangeSize = metric(trade.rangeSize);
  t.sweepDepth = metric(trade.sweepDepth);
  t.slDistPips = metric(trade.slDistPips);
  t.slippagePips = metric(trade.slippagePips);
  t.postClose15m = metric(trade.postClose15m);
  t.postClose30m = metric(trade.postClose30m);
  t.durationMin = clampInt(trade.durationMin, 0, DOJIX_LIMITS.durationLimit);
  t.timeToMFEMin = clampInt(trade.timeToMFEMin, 0, DOJIX_LIMITS.durationLimit);
  if (!(trade.hour >= 0 && trade.hour <= 23 && Number.isInteger(trade.hour))) t.hour = utcHour(trade.openTime);
  if (!VALID_DAYS.has(trade.dayOfWeek)) t.dayOfWeek = utcShortDayName(trade.openTime);
  if (trade.closeTime < trade.openTime) t.closeTime = trade.openTime;
  return t;
}

/** `Trade.storageViolations()` (Trade+Sanitize.swift:70-98): field names Dojix never stores. */
export function dojixStorageViolations(t: DojixMacTrade): string[] {
  const bad: string[] = [];
  const hasControls = [...t.symbol].some((c) => isFoundationControl(c.codePointAt(0) as number));
  if (t.symbol === "" || swiftCount(t.symbol) > DOJIX_LIMITS.symbolMaxLength || hasControls) bad.push("symbol");
  if (!Number.isFinite(t.lots) || t.lots < 0 || t.lots > DOJIX_LIMITS.maximumLots || (t.lots > 0 && t.lots < DOJIX_LIMITS.minimumLots)) {
    bad.push("lots");
  }
  const limit = DOJIX_LIMITS.moneyLimit;
  const money: [string, SwiftDecimal][] = [
    ["openPrice", t.openPrice],
    ["closePrice", t.closePrice],
    ["sl", t.sl],
    ["tp", t.tp],
    ["netProfit", t.netProfit],
    ["commission", t.commission],
    ["swap", t.swap],
  ];
  for (const [name, v] of money) {
    if (v.isNaN || v.compare(limit) > 0 || v.compare(limit.negate()) < 0) bad.push(name);
  }
  const metrics: [string, number][] = [
    ["maePips", t.maePips],
    ["mfePips", t.mfePips],
    ["rMultiple", t.rMultiple],
    ["rangeSize", t.rangeSize],
    ["sweepDepth", t.sweepDepth],
    ["slDistPips", t.slDistPips],
    ["slippagePips", t.slippagePips],
    ["postClose15m", t.postClose15m],
    ["postClose30m", t.postClose30m],
  ];
  for (const [name, v] of metrics) if (!Number.isFinite(v) || Math.abs(v) > DOJIX_LIMITS.metricLimit) bad.push(name);
  if (!(t.durationMin >= 0 && t.durationMin <= DOJIX_LIMITS.durationLimit)) bad.push("durationMin");
  if (!(t.timeToMFEMin >= 0 && t.timeToMFEMin <= DOJIX_LIMITS.durationLimit)) bad.push("timeToMFEMin");
  if (!(t.hour >= 0 && t.hour <= 23)) bad.push("hour");
  if (!VALID_DAYS.has(t.dayOfWeek)) bad.push("dayOfWeek");
  if (!screenshotList(t.screenshots).every(isValidDojixScreenshotName)) bad.push("screenshots");
  return bad;
}

/** `Trade.sanitizedForRestore()` (Trade+Sanitize.swift:102-110). */
export function sanitizeDojixForRestore(trade: DojixMacTrade): DojixMacTrade {
  const t = sanitizeDojix(trade);
  t.notes = stripFoundationControls(trade.notes, true);
  t.tags = stripFoundationControls(trade.tags, false);
  t.emotion = stripFoundationControls(trade.emotion, false);
  t.checklistData = stripFoundationControls(trade.checklistData, false);
  t.screenshots = screenshotList(trade.screenshots).filter(isValidDojixScreenshotName).join(",");
  return t;
}
