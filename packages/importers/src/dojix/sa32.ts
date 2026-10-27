// The 32-column MT5 CSV (Dojix `Services/Import/CSVParser.swift`) and the desktop's
// `DojixExport.mq5` output (the same 32 columns + Account, Commission, Swap, TimeBasis,
// ServerUTCOffset; SPEC §5.3).

import { SwiftDecimal, isBiasAlignment, isTradingSession, isVolatilityRegime } from "@dojix-desktop/core";
import type { DojixMacTrade, ImportContext, ParsedRow, RowIssue } from "../model";
import { ImportError } from "../model";
import { type CsvDialect, splitFields } from "../csv/dialect";
import { parseDatePattern } from "../swift/dates";
import { swiftDouble, swiftInt, swiftInt64 } from "../swift/numbers";
import { startsWithNumberCharacter, trimWs } from "../swift/text";
import { emptyDojixTrade } from "./generic";

/** CSVParser.swift:37 */
export const SA32_HEADER =
  "Ticket,Symbol,Direction,Lots,OpenTime,CloseTime,DurationMin,OpenPrice,ClosePrice,SL,TP,NetProfit,MAE_Pips,MFE_Pips,RMultiple,Session,DayOfWeek,Hour,RangeSize,SweepDepth,UsedFVG,VolRegime,HitBreakeven,ScaledIn,Magic,Comment,TimeToMFE_Min,SLDist_Pips,Slippage_Pips,PostClose15m,PostClose30m,BiasAtEntry";

const EXPECTED_COLUMNS = 32;
const COMMENT = 25;
/** Columns DojixExport leaves empty (strategy-specific → NULL). */
const STRATEGY_COLUMNS = [18, 19, 20, 21, 31];

/** The header prefix both Macs look for, in the file's dialect. */
export function sa32HeaderPrefix(dialect: CsvDialect): string {
  return ["Ticket", "Symbol", "Direction"].join(dialect.delimiter);
}

/** `Date.fromSADateTime` (Date+Forex.swift:61-67): "yyyy.MM.dd HH:mm:ss", UTC, POSIX. */
export function parseSaDateTime(s: string, now: number): number | null {
  return parseDatePattern(s, "yyyy.MM.dd HH:mm:ss", "UTC", now);
}

export interface Sa32Output {
  rows: ParsedRow<DojixMacTrade>[];
  issues: RowIssue[];
  /** Line (1-based) of the trade header. */
  headerLine: number;
}

interface ExportColumns {
  account: number;
  commission: number;
  swap: number;
  timeBasis: number;
  serverOffset: number;
  count: number;
}

function exportColumns(headerFields: readonly string[]): ExportColumns | null {
  const h = headerFields.map((x) => trimWs(x).toLowerCase());
  const find = (name: string) => h.indexOf(name);
  const timeBasis = find("timebasis");
  if (timeBasis < 0) return null;
  return {
    account: find("account"),
    commission: find("commission"),
    swap: find("swap"),
    timeBasis,
    serverOffset: find("serverutcoffset"),
    count: Math.max(h.length, EXPECTED_COLUMNS),
  };
}

/** True when `lines` contain a 32-column trade header. */
export function findSa32Header(lines: readonly string[], dialect: CsvDialect): number {
  const prefix = sa32HeaderPrefix(dialect);
  return lines.findIndex((l) => l.startsWith(prefix));
}

/**
 * `CSVParser.parseTradeSection` (CSVParser.swift:79-106): rows after the header until an empty
 * line or a line whose first Character is not a number. Rows that fail are skipped (and, on the
 * desktop, reported). `lines` are the file's lines without blank-line removal.
 */
export function parseSa32(lines: readonly string[], dialect: CsvDialect, ctx: ImportContext): Sa32Output {
  const headerIndex = findSa32Header(lines, dialect);
  if (headerIndex < 0) throw new ImportError("no_trade_section", "No trade detail section found in CSV");
  const headerFields = splitFields(lines[headerIndex] as string, dialect);
  // The Mac reads a DojixExport file as a plain 32-column file (extra columns ignored).
  const exp = ctx.compat === "fixed" ? exportColumns(headerFields) : null;
  const rows: ParsedRow<DojixMacTrade>[] = [];
  const issues: RowIssue[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = trimWs(lines[i] as string);
    if (line === "") break;
    if (!startsWithNumberCharacter(line)) {
      issues.push({ line: i + 1, code: "section_end", reason: "The trade section ends here (the line does not start with a ticket number)" });
      break;
    }
    const result = parseTradeLine(splitFields(line, dialect), i + 1, exp, ctx);
    if ("issue" in result) issues.push(result.issue);
    else rows.push(result.row);
  }
  return { rows, issues, headerLine: headerIndex + 1 };
}

function parseTradeLine(
  raw: string[],
  line: number,
  exp: ExportColumns | null,
  ctx: ImportContext,
): { row: ParsedRow<DojixMacTrade> } | { issue: RowIssue } {
  if (raw.length < 26) return { issue: { line, code: "too_few_columns", reason: `Expected 32 columns but got ${raw.length}` } };
  let f = raw;
  const expected = exp ? exp.count : EXPECTED_COLUMNS;
  if (ctx.compat === "fixed" && f.length > expected) {
    // PARITY D-21: unquoted commas inside Comment split it; join the extra fields back.
    const extra = f.length - expected;
    f = [...f.slice(0, COMMENT), f.slice(COMMENT, COMMENT + extra + 1).join(","), ...f.slice(COMMENT + extra + 1)];
  }
  f = [...f];
  while (f.length < EXPECTED_COLUMNS) f.push(f.length === 31 ? "NEUTRAL" : "0");
  const get = (i: number) => f[i] ?? "";
  const ticket = swiftInt64(get(0));
  if (ticket === null) return { issue: { line, code: "invalid_ticket", reason: `Invalid ticket "${get(0).slice(0, 40)}"` } };
  const dirRaw = get(2).toUpperCase();
  if (dirRaw !== "BUY" && dirRaw !== "SELL") return { issue: { line, code: "invalid_direction", reason: `Invalid direction "${get(2).slice(0, 40)}"` } };
  const openTime = parseSaDateTime(get(4), ctx.now);
  if (openTime === null) return { issue: { line, code: "invalid_date", reason: `Invalid open time "${get(4).slice(0, 40)}"` } };
  const closeTime = parseSaDateTime(get(5), ctx.now);
  if (closeTime === null) return { issue: { line, code: "invalid_date", reason: `Invalid close time "${get(5).slice(0, 40)}"` } };
  const sessionRaw = get(15).toUpperCase();
  const volRaw = get(21).toUpperCase();
  const biasRaw = trimWs(get(31)).toUpperCase();
  const dbl = (i: number) => swiftDouble(get(i)) ?? 0;
  const int = (i: number) => swiftInt(get(i)) ?? 0;
  const dec = (i: number) => SwiftDecimal.parse(get(i)) ?? SwiftDecimal.zero;
  const trade: DojixMacTrade = {
    ...emptyDojixTrade(),
    ticket,
    symbol: get(1).toUpperCase(),
    direction: dirRaw,
    lots: dbl(3),
    openTime,
    closeTime,
    durationMin: int(6),
    openPrice: dec(7),
    closePrice: dec(8),
    sl: dec(9),
    tp: dec(10),
    netProfit: dec(11),
    maePips: dbl(12),
    mfePips: dbl(13),
    rMultiple: dbl(14),
    session: isTradingSession(sessionRaw) ? sessionRaw : "LATE",
    dayOfWeek: get(16),
    hour: int(17),
    rangeSize: dbl(18),
    sweepDepth: dbl(19),
    usedFVG: get(20).toUpperCase() === "YES",
    volRegime: isVolatilityRegime(volRaw) ? volRaw : "MED",
    hitBreakeven: get(22).toUpperCase() === "YES",
    scaledIn: get(23).toUpperCase() === "YES",
    magic: int(24),
    comment: get(25),
    timeToMFEMin: int(26),
    slDistPips: dbl(27),
    slippagePips: dbl(28),
    postClose15m: dbl(29),
    postClose30m: dbl(30),
    biasAtEntry: isBiasAlignment(biasRaw) ? biasRaw : "NEUTRAL",
  };
  let timeBasis: "utc" | "broker" = "utc";
  let account: string | null = null;
  let strategyKnown = true;
  if (exp) {
    // DojixExport: NetProfit already includes costs (as in the 32-column file, SPEC §3.1);
    // Commission and Swap are informational and are not subtracted a second time.
    const basis = trimWs(f[exp.timeBasis] ?? "").toUpperCase();
    const offset = exp.serverOffset >= 0 ? swiftInt(f[exp.serverOffset] ?? "") : null;
    if (basis === "SERVER" && offset !== null && Math.abs(offset) <= 86_400) {
      trade.openTime -= offset * 1000;
      trade.closeTime -= offset * 1000;
    } else if (basis === "SERVER" || basis === "BROKER") timeBasis = "broker";
    account = exp.account >= 0 ? (f[exp.account] ?? null) : null;
    strategyKnown = !STRATEGY_COLUMNS.every((i) => (raw[i] ?? "") === "");
  }
  return {
    row: {
      trade,
      meta: {
        source: exp ? "dojix_export" : "mt5_32col",
        line,
        externalId: null,
        maeKnown: true,
        mfeKnown: true,
        strategyKnown,
        timeBasis,
        ...(account ? { account: account.slice(0, 64) } : {}),
      },
    },
  };
}
