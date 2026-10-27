// Mac trade → desktop journal row (SPEC §4.1), after the brand's storage rule (§4.3):
// Dojix clamps (`sanitizedForStorage`), Greenwick rejects (`TradeLimits`).

import { formatGrdbDate, macTagList } from "@dojix-desktop/core";
import type { CompatMode, DojixMacTrade, GreenwickMacTrade, ImportedTrade, MacTrade, ParsedRow, RowIssue } from "./model";
import { sanitizeDojix } from "./dojix/sanitize";
import { sanitizeGreenwick } from "./greenwick/limits";

function checklistJson(raw: string): string {
  if (raw === "") return "{}";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "boolean") return "{}"; // Swift decodes [String: Bool] or nothing
      out[k] = v;
    }
    return JSON.stringify(out);
  } catch {
    return "{}";
  }
}

function common(t: MacTrade, row: ParsedRow, importedAt: number) {
  return {
    ticket: t.ticket.toString(),
    source: row.meta.source,
    externalId: row.meta.externalId,
    isSample: false,
    symbol: t.symbol,
    direction: t.direction,
    openTime: formatGrdbDate(t.openTime),
    closeTime: formatGrdbDate(t.closeTime),
    timeBasis: row.meta.timeBasis,
    durationMin: t.durationMin,
    openPrice: t.openPrice.toString(),
    closePrice: t.closePrice.toString(),
    sl: t.sl.toString(),
    tp: t.tp.toString(),
    netProfit: t.netProfit.toString(),
    commission: t.commission.toString(),
    swap: t.swap.toString(),
    rMultiple: t.rMultiple,
    dayOfWeek: t.dayOfWeek,
    hour: t.hour,
    timeToMfeMin: t.timeToMFEMin,
    rangeSize: t.rangeSize,
    hitBreakeven: t.hitBreakeven,
    scaledIn: t.scaledIn,
    comment: t.comment,
    notes: t.notes,
    tags: t.tags === "" ? "[]" : JSON.stringify(macTagList(t.tags)),
    emotion: t.emotion === "" ? null : t.emotion,
    checklist: checklistJson(t.checklistData),
    importedAt: formatGrdbDate(importedAt),
  };
}

/** A sanitized Dojix trade as a journal row. In `fixed` mode unknown MAE/MFE become NULL (D-18). */
export function dojixRow(t: DojixMacTrade, row: ParsedRow, compat: CompatMode, importedAt: number): ImportedTrade {
  const strategy = row.meta.strategyKnown;
  return {
    ...common(t, row, importedAt),
    quantity: t.lots,
    session: t.session,
    mae: compat === "fixed" && !row.meta.maeKnown ? null : t.maePips,
    mfe: compat === "fixed" && !row.meta.mfeKnown ? null : t.mfePips,
    slDist: t.slDistPips,
    slippage: t.slippagePips,
    rangeSize: strategy ? t.rangeSize : null,
    sweepDepth: strategy ? t.sweepDepth : null,
    usedFvg: strategy ? t.usedFVG : null,
    volRegime: strategy ? t.volRegime : null,
    biasAtEntry: strategy ? t.biasAtEntry : null,
    magic: t.magic,
    postClose15m: t.postClose15m,
    postClose30m: t.postClose30m,
    sector: null,
    industry: null,
    volume: null,
    avgVolume: null,
  };
}

/** A validated Greenwick trade as a journal row. */
export function greenwickRow(t: GreenwickMacTrade, row: ParsedRow, compat: CompatMode, importedAt: number): ImportedTrade {
  return {
    ...common(t, row, importedAt),
    isSample: t.isSample,
    quantity: t.shares,
    session: t.session,
    mae: compat === "fixed" && !row.meta.maeKnown ? null : t.maePoints,
    mfe: compat === "fixed" && !row.meta.mfeKnown ? null : t.mfePoints,
    slDist: t.slDistPoints,
    slippage: t.slippagePoints,
    sweepDepth: null,
    usedFvg: null,
    volRegime: null,
    magic: null,
    postClose15m: null,
    postClose30m: null,
    biasAtEntry: null,
    sector: t.sector,
    industry: t.industry,
    volume: t.volume,
    avgVolume: t.avgVolume,
  };
}

/**
 * The brand's storage rule then the row mapping. Returns null with an issue when the row can't
 * be stored (Greenwick limits, or an instant outside the years the journal's text can hold).
 */
export function storeRow(row: ParsedRow, compat: CompatMode, importedAt: number): { trade: ImportedTrade } | { issue: RowIssue } {
  const t = row.trade;
  try {
    if (t.brand === "dojix") return { trade: dojixRow(sanitizeDojix(t), row, compat, importedAt) };
    const s = sanitizeGreenwick(t, importedAt);
    if (s.trade === null) {
      return { issue: { line: row.meta.line, code: "storage_rejected", reason: `Values outside what Greenwick stores: ${s.violations.join(", ")}` } };
    }
    return { trade: greenwickRow(s.trade, row, compat, importedAt) };
  } catch (e) {
    /* c8 ignore next */
    if (!(e instanceof RangeError)) throw e;
    return { issue: { line: row.meta.line, code: "storage_rejected", reason: "A date is outside the years the journal can store" } };
  }
}
