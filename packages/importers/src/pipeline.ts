// The import pipeline's TypeScript half (SPEC §5.1 steps 2–7): decode, detect, parse, derive,
// ticket, validate. Bytes come in from Rust (file, drop, scan, MT5 watcher); the result goes to
// the preview and `import_commit`.

import type { BrandId } from "@dojix-desktop/core";
import { decodeTradeFile, decodeTradeFileMac, type TextEncodingName } from "./encoding";
import type { CompatMode, FormatId, ImportContext, ImportedTrade, MacTrade, ParsedRow, RowIssue } from "./model";
import { ImportError, MAX_IMPORT_BYTES } from "./model";
import { type CsvDialect, COMMA_DIALECT, detectDialect, splitFields } from "./csv/dialect";
import { macLines, trimWs } from "./swift/text";
import { type DojixColumnMapping, DOJIX_PLATFORM_SOURCE, detectDojixHeaders, parseDojixMapped } from "./dojix/generic";
import { findSa32Header, parseSa32 } from "./dojix/sa32";
import { looksLikeMt5Report, parseMt5Report } from "./dojix/mt5-report";
import { type GreenwickColumnMapping, GREENWICK_PLATFORM_SOURCE, detectGreenwickHeaders, needsFifo, parseGreenwickMapped } from "./greenwick/generic";
import { parseGreenwickTransactions } from "./greenwick/transactions";
import { type OandaTransaction, decodeOandaPage, mapOandaTransactions } from "./dojix/oanda-api";
import { storeRow } from "./rows";
import { sha256, toHex } from "./hash";

export type ColumnMapping = DojixColumnMapping | GreenwickColumnMapping;

export interface ImportOptions {
  brand: BrandId;
  /** Defaults to "fixed" (what the app ships). */
  compat?: CompatMode;
  /** Epoch ms (importedAt, two-digit years). */
  now: number;
  /** A user's column mapping for an unrecognised file (the mapping sheet or a saved preset). */
  mapping?: ColumnMapping;
  /** The file's name. Only `swift` compat uses it: the Mac routes "StrategyAnalytics*" / "SA_Results*" files by name. */
  fileName?: string;
}

export interface DetectOptions {
  compat?: CompatMode;
  fileName?: string;
}

export interface Detection {
  format: FormatId;
  dialect: CsvDialect;
  /** Header fields (of the detected header line, or line 1). */
  headers: string[];
  /** Up to five rows after the header, for the mapping sheet. */
  sampleRows: string[][];
  /** The platform mapping (null for the 32-column file, the MT5 report and unknown files). */
  mapping: ColumnMapping | null;
  /** True when the user must map columns before anything can be imported. */
  needsMapping: boolean;
}

export interface ImportResult {
  format: FormatId;
  encoding: TextEncodingName;
  dialect: CsvDialect;
  /** Rows ready for `import_commit`, in file order (FIFO platforms: by open time). */
  trades: ImportedTrade[];
  /** Every row that was not imported, with the reason. */
  issues: RowIssue[];
  /** Rows the parser turned into trades (before validation and in-file duplicates). */
  parsed: number;
  /** Option rows skipped (Greenwick, D-22). */
  optionsSkipped: number;
  /** Duplicate tickets inside the file (the Mac counts them as duplicates). */
  duplicatesInFile: number;
  /** The parsed Mac trades before the storage rule (for the parity harness). */
  mac: MacTrade[];
  /** Set when the file needs a column mapping (no trades were read). */
  detection: Detection;
}

interface NumberedLine {
  text: string;
  line: number;
}

function numberedNonBlank(text: string): NumberedLine[] {
  const out: NumberedLine[] = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as string;
    if (trimWs(t) !== "") out.push({ text: t, line: i + 1 });
  }
  return out;
}

function dialectOf(lines: readonly NumberedLine[]): CsvDialect {
  // The first line with a delimiter decides (a title line above the header has none).
  for (const l of lines.slice(0, 3)) {
    const d = detectDialect(l.text);
    if (d) return d;
  }
  return COMMA_DIALECT;
}

/** True for the file names the Mac sends straight to the 32-column parser (ImportViewModel.swift:63). */
export function isMac32ColumnFileName(name: string | undefined): boolean {
  return name !== undefined && (name.startsWith("StrategyAnalytics") || name.startsWith("SA_Results"));
}

/**
 * The Mac's routing (`swift` compat): Dojix sends "StrategyAnalytics*" files to the 32-column
 * parser by name and otherwise looks at line 1 only (a multi-section file with another name
 * goes to the mapping sheet); comma only; no MT5 report or DojixExport.
 */
function detectMac(text: string, brand: BrandId, fileName: string | undefined): Detection {
  const dialect = COMMA_DIALECT;
  if (brand === "dojix" && isMac32ColumnFileName(fileName)) return { format: "mt5_32col", dialect, headers: [], sampleRows: [], mapping: null, needsMapping: false };
  const content = brand === "greenwick" && text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = numberedNonBlank(content);
  if (lines.length === 0) throw new ImportError("empty_file", "The file is empty");
  const fieldsOf = (l: NumberedLine | undefined) => (l ? splitFields(l.text, dialect) : []);
  const samples = (from: number) => lines.slice(from, from + 5).map((l) => fieldsOf(l));
  if (brand === "dojix") {
    const headers = fieldsOf(lines[0]);
    const d = detectDojixHeaders(headers);
    if (d.kind === "mt5_32col") return { format: "mt5_32col", dialect, headers, sampleRows: [], mapping: null, needsMapping: false };
    if (d.kind === "mapped") return { format: DOJIX_PLATFORM_SOURCE[d.mapping.platform] as FormatId, dialect, headers, sampleRows: samples(1), mapping: d.mapping, needsMapping: false };
    return { format: "generic", dialect, headers, sampleRows: samples(1), mapping: null, needsMapping: true };
  }
  return detectGreenwick(lines, dialect, fieldsOf, samples);
}

function detectGreenwick(
  lines: readonly NumberedLine[],
  dialect: CsvDialect,
  fieldsOf: (l: NumberedLine | undefined) => string[],
  samples: (from: number) => string[][],
): Detection {
  // Line 1, then line 2 (Schwab / Fidelity title lines).
  for (const at of [0, 1]) {
    const headers = fieldsOf(lines[at]);
    const m = at < lines.length ? detectGreenwickHeaders(headers) : null;
    if (m) return { format: GREENWICK_PLATFORM_SOURCE[m.platform] as FormatId, dialect, headers, sampleRows: samples(at + 1), mapping: m, needsMapping: false };
  }
  return { format: "generic", dialect, headers: fieldsOf(lines[0]), sampleRows: samples(1), mapping: null, needsMapping: true };
}

/** Detects a decoded file's format for `brand` (SPEC §5.1 step 3). */
export function detectFormat(text: string, brand: BrandId, options: DetectOptions = {}): Detection {
  if (options.compat === "swift") return detectMac(text, brand, options.fileName);
  const lines = numberedNonBlank(text);
  if (lines.length === 0) throw new ImportError("empty_file", "The file is empty");
  const dialect = dialectOf(lines);
  const fieldsOf = (l: NumberedLine | undefined) => (l ? splitFields(l.text, dialect) : []);
  const samples = (from: number) => lines.slice(from, from + 5).map((l) => fieldsOf(l));
  if (brand === "dojix") {
    if (looksLikeMt5Report(text)) return { format: "mt5_report", dialect, headers: [], sampleRows: [], mapping: null, needsMapping: false };
    const all = macLines(text, false);
    const headerIdx = findSa32Header(all, dialect);
    if (headerIdx >= 0) {
      const headers = splitFields(all[headerIdx] as string, dialect);
      const isExport = headers.some((h) => trimWs(h).toLowerCase() === "timebasis");
      return { format: isExport ? "dojix_export" : "mt5_32col", dialect, headers, sampleRows: [], mapping: null, needsMapping: false };
    }
    const headers = fieldsOf(lines[0]);
    const d = detectDojixHeaders(headers);
    if (d.kind === "mt5_32col") throw new ImportError("no_trade_section", "No trade detail section found in CSV");
    if (d.kind === "mapped") {
      return { format: DOJIX_PLATFORM_SOURCE[d.mapping.platform] as FormatId, dialect, headers, sampleRows: samples(1), mapping: d.mapping, needsMapping: false };
    }
    return { format: "generic", dialect, headers, sampleRows: samples(1), mapping: null, needsMapping: true };
  }
  return detectGreenwick(lines, dialect, fieldsOf, samples);
}

/** A stable signature of a header row, for `mapping_presets.header_signature`. */
export function headerSignature(headers: readonly string[]): string {
  return toHex(sha256(new TextEncoder().encode(headers.map((h) => trimWs(h).toLowerCase()).join("\u001f"))));
}

/** Imports decoded text (see `importTradeFile`). */
export function importTradeText(text: string, encoding: TextEncodingName, options: ImportOptions): ImportResult {
  const ctx: ImportContext = { brand: options.brand, compat: options.compat ?? "fixed", now: options.now };
  const detection = detectFormat(text, ctx.brand, { compat: ctx.compat, ...(options.fileName !== undefined ? { fileName: options.fileName } : {}) });
  if (ctx.brand === "greenwick" && ctx.compat === "swift" && text.startsWith("\uFEFF")) text = text.slice(1);
  let rows: ParsedRow[];
  let issues: RowIssue[];
  let optionsSkipped = 0;
  const lines = numberedNonBlank(text);
  if (detection.format === "mt5_report") {
    ({ rows, issues } = parseMt5Report(text, ctx));
  } else if (detection.format === "mt5_32col" || detection.format === "dojix_export") {
    ({ rows, issues } = parseSa32(macLines(text, false), detection.dialect, ctx));
  } else {
    const mapping = detection.mapping ?? options.mapping ?? null;
    if (mapping === null) {
      return { format: "generic", encoding, dialect: detection.dialect, trades: [], issues: [], parsed: 0, optionsSkipped: 0, duplicatesInFile: 0, mac: [], detection };
    }
    if (ctx.brand === "dojix") {
      if (!("lots" in mapping)) throw new TypeError("a Dojix import needs a Dojix column mapping");
      if (lines.length <= 1) throw new ImportError("empty_file", "The file has no rows after the header");
      ({ rows, issues } = parseDojixMapped(lines, mapping, detection.dialect, ctx));
    } else {
      if (!("shares" in mapping)) throw new TypeError("a Greenwick import needs a Greenwick column mapping");
      let out;
      if (needsFifo(mapping.platform)) out = parseGreenwickTransactions(lines, mapping.platform, detection.dialect, ctx);
      else {
        if (lines.length <= 1) throw new ImportError("empty_file", "The file has no rows after the header");
        out = parseGreenwickMapped(lines, mapping, detection.dialect, ctx);
      }
      ({ rows, issues, optionsSkipped } = out);
    }
  }
  const stored = storeRows(rows, ctx, issues);
  const format = detection.format === "generic" && options.mapping ? "generic" : detection.format;
  return { format, encoding, dialect: detection.dialect, ...stored, issues, parsed: rows.length, optionsSkipped, mac: rows.map((r) => r.trade), detection };
}

/** The storage rule, in-file duplicate tickets and the issue order: shared by files and the OANDA API. */
function storeRows(rows: readonly ParsedRow[], ctx: ImportContext, issues: RowIssue[]): { trades: ImportedTrade[]; duplicatesInFile: number } {
  const trades: ImportedTrade[] = [];
  const seen = new Set<string>();
  let duplicatesInFile = 0;
  for (const row of rows) {
    const stored = storeRow(row, ctx.compat, ctx.now);
    if ("issue" in stored) {
      issues.push(stored.issue);
      continue;
    }
    if (seen.has(stored.trade.ticket)) {
      duplicatesInFile++;
      issues.push({ line: row.meta.line, code: "duplicate_in_file", reason: `Ticket ${stored.trade.ticket} appears earlier in this file` });
      continue;
    }
    seen.add(stored.trade.ticket);
    trades.push(stored.trade);
  }
  issues.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
  return { trades, duplicatesInFile };
}

/**
 * OANDA v20 API import (SPEC §8.4): the `transactions` pages the Rust client fetched, decoded,
 * paired and stored like a file import. A page that doesn't decode makes the whole import fail
 * (null), as `JSONDecoder` does on the Mac.
 */
export function importOandaPages(pages: readonly unknown[], options: Omit<ImportOptions, "brand" | "mapping" | "fileName">): { trades: ImportedTrade[]; issues: RowIssue[]; parsed: number } | null {
  const ctx: ImportContext = { brand: "dojix", compat: options.compat ?? "fixed", now: options.now };
  const transactions: OandaTransaction[] = [];
  for (const page of pages) {
    const decoded = decodeOandaPage(page);
    if (decoded === null) return null;
    transactions.push(...decoded);
  }
  const { rows, issues } = mapOandaTransactions(transactions, ctx);
  const { trades } = storeRows(rows, ctx, issues);
  return { trades, issues, parsed: rows.length };
}

/**
 * Imports a trade file's bytes for `brand`: decode (BOM / UTF-8 / Windows-1252), detect, parse,
 * derive, ticket and validate. Throws `ImportError` for file-level failures (too large, empty,
 * no trade section). Nothing is ever dropped silently: every skipped row is in `issues`.
 */
export function importTradeFile(bytes: Uint8Array, options: ImportOptions): ImportResult {
  if (bytes.length > MAX_IMPORT_BYTES) throw new ImportError("too_large", "The file is larger than 50 MB");
  const decoded = options.compat === "swift" ? decodeTradeFileMac(bytes) : decodeTradeFile(bytes);
  return importTradeText(decoded.text, decoded.encoding, options);
}
