// Greenwick storage limits: `TradeLimits` and `Trade+Storage.swift` (reject, never clamp).

import { SwiftDecimal, swiftCount } from "@dojix-desktop/core";
import type { GreenwickMacTrade } from "../model";
import { hasGreenwickControls, removeGreenwickControls } from "../swift/text";
import { isValidGreenwickScreenshotName, screenshotList } from "../screenshots";

/** Trade+Storage.swift:6-27. */
export const TRADE_LIMITS = Object.freeze({
  maxShares: 1_000_000_000,
  minShares: 0.000_001,
  maxAbsAmount: SwiftDecimal.fromInteger(1_000_000_000_000),
  maxDurationMin: 20 * 366 * 24 * 60,
  maxAbsPoints: 1_000_000_000,
  maxVolume: 1_000_000_000_000,
  maxTextLength: 100_000,
  maxLabelLength: 200,
  maxSymbolLength: 32,
  maxScreenshots: 10,
  /** Unix seconds, 1900-01-01 … 2200-01-01. */
  dateRangeSeconds: [-2_208_988_800, 7_258_118_400] as const,
});

function amountOutOfRange(v: SwiftDecimal): boolean {
  const max = TRADE_LIMITS.maxAbsAmount;
  return v.isNaN || v.compare(max) > 0 || v.compare(max.negate()) < 0;
}

function inDateRange(ms: number): boolean {
  const s = ms / 1000;
  return s >= TRADE_LIMITS.dateRangeSeconds[0] && s <= TRADE_LIMITS.dateRangeSeconds[1];
}

/** `Trade.storageViolations` (Trade+Storage.swift:35-75). `importedAt` is the row's import instant. */
export function greenwickStorageViolations(t: GreenwickMacTrade, importedAt: number): string[] {
  const bad: string[] = [];
  if (!(Number.isFinite(t.shares) && t.shares >= TRADE_LIMITS.minShares && t.shares <= TRADE_LIMITS.maxShares)) bad.push("shares");
  const amounts: [string, SwiftDecimal][] = [
    ["openPrice", t.openPrice],
    ["closePrice", t.closePrice],
    ["sl", t.sl],
    ["tp", t.tp],
    ["netProfit", t.netProfit],
    ["commission", t.commission],
    ["swap", t.swap],
  ];
  for (const [name, v] of amounts) if (amountOutOfRange(v)) bad.push(name);
  const points: [string, number][] = [
    ["maePoints", t.maePoints],
    ["mfePoints", t.mfePoints],
    ["rMultiple", t.rMultiple],
    ["rangeSize", t.rangeSize],
    ["slDistPoints", t.slDistPoints],
    ["slippagePoints", t.slippagePoints],
  ];
  for (const [name, v] of points) if (!Number.isFinite(v) || Math.abs(v) > TRADE_LIMITS.maxAbsPoints) bad.push(name);
  if (!(t.durationMin >= 0 && t.durationMin <= TRADE_LIMITS.maxDurationMin)) bad.push("durationMin");
  if (!(t.timeToMFEMin >= 0 && t.timeToMFEMin <= TRADE_LIMITS.maxDurationMin)) bad.push("timeToMFEMin");
  if (!(t.hour >= 0 && t.hour <= 23)) bad.push("hour");
  if (!(t.volume >= 0 && t.volume <= TRADE_LIMITS.maxVolume)) bad.push("volume");
  if (!(t.avgVolume >= 0 && t.avgVolume <= TRADE_LIMITS.maxVolume)) bad.push("avgVolume");
  if (t.ticket <= 0n) bad.push("ticket");
  const dates: [string, number][] = [
    ["openTime", t.openTime],
    ["closeTime", t.closeTime],
    ["importedAt", importedAt],
  ];
  for (const [name, ms] of dates) if (!inDateRange(ms)) bad.push(name);
  if (t.symbol === "" || swiftCount(t.symbol) > TRADE_LIMITS.maxSymbolLength) bad.push("symbol");
  const labels: [string, string][] = [
    ["comment", t.comment],
    ["dayOfWeek", t.dayOfWeek],
    ["sector", t.sector],
    ["industry", t.industry],
    ["tags", t.tags],
    ["emotion", t.emotion],
  ];
  for (const [name, text] of labels) if (exceeds(text, TRADE_LIMITS.maxLabelLength)) bad.push(name);
  if (exceeds(t.notes, TRADE_LIMITS.maxTextLength)) bad.push("notes");
  if (exceeds(t.checklistData, TRADE_LIMITS.maxTextLength)) bad.push("checklistData");
  const shots = screenshotList(t.screenshots);
  if (shots.length > TRADE_LIMITS.maxScreenshots || !shots.every(isValidGreenwickScreenshotName)) bad.push("screenshots");
  return bad;
}

/** Character count above `limit` (cheap check first: a string never has more Characters than code units). */
function exceeds(text: string, limit: number): boolean {
  return text.length > limit && swiftCount(text) > limit;
}

/** `Trade.controlCharacterFields` (Trade+Storage.swift:78-88). */
export function greenwickControlCharacterFields(t: GreenwickMacTrade): string[] {
  const bad: string[] = [];
  const fields: [string, string][] = [
    ["symbol", t.symbol],
    ["comment", t.comment],
    ["dayOfWeek", t.dayOfWeek],
    ["sector", t.sector],
    ["industry", t.industry],
    ["tags", t.tags],
    ["emotion", t.emotion],
    ["screenshots", t.screenshots],
    ["checklistData", t.checklistData],
  ];
  for (const [name, text] of fields) if (hasGreenwickControls(text, false)) bad.push(name);
  if (hasGreenwickControls(t.notes, true)) bad.push("notes");
  return bad;
}

/** `Trade+Storage.validScreenshotList`. */
export function validGreenwickScreenshotList(raw: string): string {
  return screenshotList(raw).filter(isValidGreenwickScreenshotName).slice(0, TRADE_LIMITS.maxScreenshots).join(",");
}

/** `Trade.sanitizedForStorage()` (Trade+Storage.swift:103-116): null when a value is outside `TradeLimits`. */
export function sanitizeGreenwick(trade: GreenwickMacTrade, importedAt: number): { trade: GreenwickMacTrade | null; violations: string[] } {
  const t: GreenwickMacTrade = {
    ...trade,
    symbol: removeGreenwickControls(trade.symbol, false),
    comment: removeGreenwickControls(trade.comment, false),
    dayOfWeek: removeGreenwickControls(trade.dayOfWeek, false),
    sector: removeGreenwickControls(trade.sector, false),
    industry: removeGreenwickControls(trade.industry, false),
    tags: removeGreenwickControls(trade.tags, false),
    emotion: removeGreenwickControls(trade.emotion, false),
    checklistData: removeGreenwickControls(trade.checklistData, false),
    notes: removeGreenwickControls(trade.notes, true),
    screenshots: validGreenwickScreenshotList(trade.screenshots),
  };
  const violations = greenwickStorageViolations(t, importedAt);
  return violations.length === 0 ? { trade: t, violations } : { trade: null, violations };
}
