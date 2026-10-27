// Greenwick `Services/Import/GenericCSVParser.swift`: detection, the matched-row platforms
// (Interactive Brokers, thinkorswim, TradingView, NinjaTrader, Webull, generic mapping) and the
// shared field parsers. Transaction platforms (FIFO) are in transactions.ts.

import { POSIX_WEEKDAY_NAMES, SwiftDecimal, TRADING_CALENDAR, graphemes, intSaturating, sessionAtMinute, swiftPrefix } from "@dojix-desktop/core";
import type { GreenwickMacTrade, ImportContext, ImportSource, ParsedRow, RowIssue } from "../model";
import { type CsvDialect, splitFields } from "../csv/dialect";
import { DateParsers } from "../swift/dates";
import { swiftDouble, swiftInt } from "../swift/numbers";
import { keepLettersDigitsDots, trimWs } from "../swift/text";
import { greenwickSlDistAndR } from "../derive";
import { GreenwickTicketCounter } from "../tickets";
import { directionOf } from "../dojix/generic";
import { TRADE_LIMITS } from "./limits";

export type GreenwickPlatform =
  | "interactiveBrokers"
  | "thinkorswim"
  | "tradingView"
  | "ninjaTrader"
  | "webull"
  | "robinhood"
  | "schwab"
  | "fidelity"
  | "etrade"
  | "tastytrade"
  | "generic";

/** `Platform.rawValue` (GenericCSVParser.swift:11-22), part of every ticket key. */
export const GREENWICK_PLATFORM_NAME: Readonly<Record<GreenwickPlatform, string>> = {
  interactiveBrokers: "Interactive Brokers",
  thinkorswim: "Thinkorswim",
  tradingView: "TradingView",
  ninjaTrader: "NinjaTrader",
  webull: "Webull",
  robinhood: "Robinhood",
  schwab: "Charles Schwab",
  fidelity: "Fidelity",
  etrade: "E*Trade",
  tastytrade: "Tastytrade",
  generic: "Generic CSV",
};

export const GREENWICK_PLATFORM_SOURCE: Readonly<Record<GreenwickPlatform, ImportSource>> = {
  interactiveBrokers: "ibkr",
  thinkorswim: "tos",
  tradingView: "tradingview",
  ninjaTrader: "ninjatrader",
  webull: "webull",
  robinhood: "robinhood",
  schwab: "schwab",
  fidelity: "fidelity",
  etrade: "etrade",
  tastytrade: "tastytrade",
  generic: "generic",
};

/** `Platform.needsFIFOPairing` (GenericCSVParser.swift:25-30). */
export function needsFifo(p: GreenwickPlatform): boolean {
  return p === "robinhood" || p === "schwab" || p === "fidelity" || p === "etrade" || p === "tastytrade";
}

/** `ColumnMapping` (GenericCSVParser.swift:612-634). */
export interface GreenwickColumnMapping {
  platform: GreenwickPlatform;
  ticket: number | null;
  symbol: number;
  direction: number;
  shares: number;
  openTime: number;
  closeTime: number | null;
  openPrice: number;
  closePrice: number | null;
  sl: number | null;
  tp: number | null;
  profit: number;
  commission: number | null;
  swap: number | null;
  maePoints: number | null;
  mfePoints: number | null;
  volume: number | null;
  dateFormat: string;
}

const lowerTrim = (h: readonly string[]): string[] => h.map((x) => trimWs(x.toLowerCase()));
function idx(h: readonly string[], ...names: string[]): number | null {
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return null;
}
const or0 = (v: number | null): number => v ?? 0;

function base(platform: GreenwickPlatform): GreenwickColumnMapping {
  return {
    platform, ticket: null, symbol: 0, direction: 0, shares: 0, openTime: 0, closeTime: null, openPrice: 0, closePrice: null,
    sl: null, tp: null, profit: 0, commission: null, swap: null, maePoints: null, mfePoints: null, volume: null, dateFormat: "",
  };
}

/** GenericCSVParser.swift:766-884: the per-platform mappings. */
function mappingFor(platform: GreenwickPlatform, headers: readonly string[]): GreenwickColumnMapping {
  const h = lowerTrim(headers);
  switch (platform) {
    case "interactiveBrokers":
      return {
        ...base(platform),
        ticket: idx(h, "tradeid"),
        symbol: or0(idx(h, "symbol")),
        direction: or0(idx(h, "side", "buy/sell")),
        shares: or0(idx(h, "quantity", "shares")),
        openTime: or0(idx(h, "date/time", "tradetime")),
        openPrice: or0(idx(h, "t. price", "tradeprice")),
        closePrice: idx(h, "c. price", "closeprice"),
        profit: or0(idx(h, "realized p/l", "mtm p/l", "proceeds")),
        commission: idx(h, "comm/fee", "commission"),
        dateFormat: "yyyy-MM-dd, HH:mm:ss",
      };
    case "thinkorswim":
      return {
        ...base(platform),
        symbol: or0(idx(h, "symbol")),
        direction: or0(idx(h, "side")),
        shares: or0(idx(h, "qty", "amount")),
        openTime: or0(idx(h, "exec time", "date")),
        openPrice: or0(idx(h, "price", "net price")),
        profit: or0(idx(h, "p/l", "net cash")),
        commission: idx(h, "commission", "commissions"),
        dateFormat: "MM/dd/yy HH:mm:ss",
      };
    case "tradingView":
      return {
        ...base(platform),
        ticket: idx(h, "trade #"),
        symbol: or0(idx(h, "symbol")),
        direction: or0(idx(h, "type", "side")),
        shares: or0(idx(h, "contracts", "qty")),
        openTime: or0(idx(h, "date/time", "date")),
        openPrice: or0(idx(h, "price")),
        profit: or0(idx(h, "profit", "cumulative profit")),
        maePoints: idx(h, "drawdown"),
        mfePoints: idx(h, "run-up"),
        dateFormat: "yyyy-MM-dd'T'HH:mm:ssZ",
      };
    case "ninjaTrader":
      return {
        ...base(platform),
        ticket: idx(h, "trade #"),
        symbol: or0(idx(h, "instrument")),
        direction: or0(idx(h, "market position")),
        shares: or0(idx(h, "quantity", "qty")),
        openTime: or0(idx(h, "entry time")),
        closeTime: idx(h, "exit time"),
        openPrice: or0(idx(h, "entry price")),
        closePrice: idx(h, "exit price"),
        profit: or0(idx(h, "profit", "net profit")),
        commission: idx(h, "commission"),
        maePoints: idx(h, "mae"),
        mfePoints: idx(h, "mfe"),
        dateFormat: "MM/dd/yyyy HH:mm:ss",
      };
    case "webull":
      return {
        ...base(platform),
        ticket: idx(h, "order number", "order id"),
        symbol: or0(idx(h, "symbol")),
        direction: or0(idx(h, "side", "action")),
        shares: or0(idx(h, "filled qty", "qty")),
        openTime: or0(idx(h, "filled time", "date")),
        openPrice: or0(idx(h, "avg price", "price")),
        profit: or0(idx(h, "realized p&l", "p&l")),
        commission: idx(h, "commission"),
        dateFormat: "MM/dd/yyyy HH:mm:ss",
      };
    default:
      return base(platform); // transaction platforms: detection only (GenericCSVParser.swift:136-143)
  }
}

/** `detectPlatform` (GenericCSVParser.swift:79-133). */
export function detectGreenwickHeaders(headers: readonly string[]): GreenwickColumnMapping | null {
  const set = new Set(lowerTrim(headers));
  const has = (...names: string[]) => names.every((n) => set.has(n));
  const any = (...names: string[]) => names.some((n) => set.has(n));
  let platform: GreenwickPlatform | null = null;
  if (has("tradeid", "symbol", "quantity", "t. price")) platform = "interactiveBrokers";
  else if (has("exec time", "side", "qty", "symbol")) platform = "thinkorswim";
  else if (has("trade #", "signal", "contracts")) platform = "tradingView";
  else if (has("trade #", "instrument", "market position", "entry price")) platform = "ninjaTrader";
  else if (has("symbol", "filled qty", "avg price")) platform = "webull";
  else if (has("trans code", "instrument", "activity date")) platform = "robinhood";
  else if (has("action", "fees & comm", "symbol")) platform = "schwab";
  else if (has("run date", "security description", "action")) platform = "fidelity";
  else if (any("transactiontype", "transaction type") && any("securitytype", "security type")) platform = "etrade";
  else if (any("underlying symbol", "root symbol") && any("commissions", "clearing fees")) platform = "tastytrade";
  return platform ? mappingFor(platform, headers) : null;
}

/** `cleanSymbol` (GenericCSVParser.swift:932-938): upper-cased, letters/digits/dots only, at most 10 Characters. */
export function greenwickCleanSymbol(raw: string): string {
  const upper = trimWs(raw.toUpperCase());
  // ASCII fast path: letters, digits and "." are single Characters.
  if (/^[\x20-\x7e]*$/.test(upper)) return upper.replace(/[^A-Z0-9.]/g, "").slice(0, 10);
  return swiftPrefix(keepLettersDigitsDots(upper), 10);
}

/** `sanitizeImportField` (GenericCSVParser.swift:941-944): drops one leading formula character. */
export function sanitizeImportField(field: string): string {
  const first = field[0];
  if (first === undefined || !"=+@-\t\r".includes(first)) return field;
  // Swift compares the first Character: a formula character with a combining mark is not one.
  const firstCharacter = field.length > 1 && field.charCodeAt(1) >= 0x80 ? graphemes(field.slice(0, 32))[0] : first;
  return firstCharacter === first ? field.slice(1) : field;
}

/** `parseShares` (GenericCSVParser.swift:953-959). */
export function parseShares(raw: string): number | null {
  const v = swiftDouble(trimWs(raw.replaceAll(",", "")));
  if (v === null || !Number.isFinite(v)) return null;
  const shares = Math.abs(v);
  return shares >= TRADE_LIMITS.minShares && shares <= TRADE_LIMITS.maxShares ? shares : null;
}

/** `stripCurrencyChars` (GenericCSVParser.swift:978-987). */
export function stripCurrencyChars(raw: string): string {
  let s = trimWs(raw);
  if (s.startsWith("(") && s.endsWith(")")) s = `-${s.length >= 2 ? s.slice(1, -1) : ""}`;
  return trimWs(s.replaceAll("$", "").replaceAll(",", ""));
}

/** `parseDecimal` (GenericCSVParser.swift:962-968). */
export function parseGreenwickDecimal(raw: string | undefined): SwiftDecimal | null {
  if (raw === undefined) return null;
  const cleaned = stripCurrencyChars(raw);
  if (cleaned === "") return null;
  const v = SwiftDecimal.parse(cleaned);
  if (v === null || v.isNaN) return null;
  const max = TRADE_LIMITS.maxAbsAmount;
  return v.compare(max) > 0 || v.compare(max.negate()) < 0 ? null : v;
}

/** `parseBoundedDouble` (GenericCSVParser.swift:971-975). */
export function parseBoundedDouble(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const v = swiftDouble(raw.replaceAll(",", ""));
  return v !== null && Number.isFinite(v) && Math.abs(v) <= TRADE_LIMITS.maxAbsPoints ? v : null;
}

const GREENWICK_FORMATS = [
  "yyyy-MM-dd HH:mm:ss", "MM/dd/yyyy HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd, HH:mm:ss",
  "MM/dd/yy HH:mm:ss", "dd/MM/yyyy HH:mm:ss", "yyyy-MM-dd", "M/d/yyyy", "MM/dd/yyyy", "MM/dd/yy", "M/d/yy",
];

const parserCache = new Map<string, DateParsers>();
/** `parseDateTime(_:format:)` (GenericCSVParser.swift:989-1013): exchange time (ET). */
export function parseGreenwickDate(s: string, format: string, now: number): number | null {
  const key = `${format}\u0000${Math.trunc(now / 86_400_000)}`;
  let p = parserCache.get(key);
  if (!p) {
    p = new DateParsers([format, ...GREENWICK_FORMATS], "America/New_York", now);
    if (parserCache.size > 64) parserCache.clear();
    parserCache.set(key, p);
  }
  return p.parse(s, trimWs);
}

export function emptyGreenwickTrade(): GreenwickMacTrade {
  return {
    brand: "greenwick", ticket: 0n, symbol: "", direction: "BUY", shares: 0, openTime: 0, closeTime: 0, durationMin: 0,
    openPrice: SwiftDecimal.zero, closePrice: SwiftDecimal.zero, sl: SwiftDecimal.zero, tp: SwiftDecimal.zero, netProfit: SwiftDecimal.zero,
    maePoints: 0, mfePoints: 0, rMultiple: 0, session: "EXTENDED", dayOfWeek: "", hour: 0, rangeSize: 0, hitBreakeven: false,
    scaledIn: false, comment: "", timeToMFEMin: 0, slDistPoints: 0, slippagePoints: 0, sector: "", industry: "", volume: 0, avgVolume: 0,
    notes: "", tags: "", emotion: "", screenshots: "", checklistData: "", commission: SwiftDecimal.zero, swap: SwiftDecimal.zero, isSample: false,
  };
}

/** Derived ET fields from the open time and the duration (GenericCSVParser.swift:713-716, 262-264). */
export function greenwickTimeFields(openTime: number, closeTime: number): Pick<GreenwickMacTrade, "durationMin" | "session" | "dayOfWeek" | "hour"> {
  // One ET field lookup gives what etSession / etWeekdayName / etHour each compute.
  const f = TRADING_CALENDAR.fields(openTime);
  const weekend = f.weekday === 1 || f.weekday === 7;
  return {
    durationMin: Math.max(0, intSaturating((closeTime - openTime) / 60_000, "greenwick")),
    session: weekend ? "EXTENDED" : sessionAtMinute(f.hour * 60 + f.minute),
    dayOfWeek: POSIX_WEEKDAY_NAMES[f.weekday - 1] as GreenwickMacTrade["dayOfWeek"],
    hour: f.hour,
  };
}

class RowError extends Error {
  constructor(readonly issue: Omit<RowIssue, "line">) {
    super(issue.reason);
  }
}

const at = (fields: readonly string[], i: number | null): string | undefined => (i === null || i < 0 ? undefined : fields[i]);

interface Mapped {
  trade: GreenwickMacTrade;
  maeKnown: boolean;
  mfeKnown: boolean;
}

/** `mapToTrade` (GenericCSVParser.swift:638-762). */
function mapToTrade(fields: readonly string[], m: GreenwickColumnMapping, ticket: bigint, now: number): Mapped {
  const symbol = greenwickCleanSymbol(at(fields, m.symbol) ?? "");
  if (symbol === "") throw new RowError({ code: "missing_symbol", reason: "No symbol" });
  const dirStr = sanitizeImportField(trimWs((at(fields, m.direction) ?? "").toUpperCase()));
  const direction = directionOf(dirStr);
  if (direction === null) throw new RowError({ code: "invalid_direction", reason: `Cannot tell buy or sell from "${dirStr.slice(0, 40)}"` });
  const shares = parseShares(at(fields, m.shares) ?? "");
  if (shares === null) throw new RowError({ code: "invalid_quantity", reason: "Shares must be a number above 0" });
  const openStr = at(fields, m.openTime) ?? "";
  const openTime = parseGreenwickDate(openStr, m.dateFormat, now);
  if (openTime === null) throw new RowError({ code: "invalid_date", reason: `Cannot read the date "${openStr.slice(0, 40)}"` });
  const closeStr = at(fields, m.closeTime);
  const closeTime = (closeStr !== undefined ? parseGreenwickDate(closeStr, m.dateFormat, now) : null) ?? openTime;
  const openPrice = parseGreenwickDecimal(at(fields, m.openPrice)) ?? SwiftDecimal.zero;
  const closePrice = (m.closePrice !== null ? parseGreenwickDecimal(at(fields, m.closePrice)) : null) ?? openPrice;
  const profit = parseGreenwickDecimal(at(fields, m.profit)) ?? SwiftDecimal.zero;
  const commRaw = (m.commission !== null ? parseGreenwickDecimal(at(fields, m.commission)) : null) ?? SwiftDecimal.zero;
  const commission = commRaw.sign() < 0 ? commRaw.negate() : commRaw;
  const swap = (m.swap !== null ? parseGreenwickDecimal(at(fields, m.swap)) : null) ?? SwiftDecimal.zero;
  const netProfit = profit.subtract(commission).subtract(swap);
  const max = TRADE_LIMITS.maxAbsAmount;
  if (netProfit.compare(max) > 0 || netProfit.compare(max.negate()) < 0) throw new RowError({ code: "out_of_range", reason: "P&L out of range" });
  const sl = (m.sl !== null ? parseGreenwickDecimal(at(fields, m.sl)) : null) ?? SwiftDecimal.zero;
  const tp = (m.tp !== null ? parseGreenwickDecimal(at(fields, m.tp)) : null) ?? SwiftDecimal.zero;
  const mae = m.maePoints !== null ? parseBoundedDouble(at(fields, m.maePoints)) : null;
  const mfe = m.mfePoints !== null ? parseBoundedDouble(at(fields, m.mfePoints)) : null;
  const volText = at(fields, m.volume);
  const volParsed = volText !== undefined ? swiftInt(volText) : null;
  const volume = volParsed === null ? 0 : Math.max(0, volParsed);
  const { slDistPoints, rMultiple } = greenwickSlDistAndR(openPrice, sl, netProfit, shares);
  return {
    trade: {
      ...emptyGreenwickTrade(),
      ticket,
      symbol,
      direction,
      shares,
      openTime,
      closeTime,
      ...greenwickTimeFields(openTime, closeTime),
      openPrice,
      closePrice,
      sl,
      tp,
      netProfit,
      maePoints: mae ?? 0,
      mfePoints: mfe ?? 0,
      rMultiple,
      slDistPoints,
      volume,
      commission,
      swap,
    },
    maeKnown: mae !== null,
    mfeKnown: mfe !== null,
  };
}

export interface GreenwickParseOutput {
  rows: ParsedRow<GreenwickMacTrade>[];
  issues: RowIssue[];
  optionsSkipped: number;
}

/**
 * `GenericCSVParser.parse(fileAt:mapping:)` for matched-row platforms (GenericCSVParser.swift:148-186).
 * `lines` are the file's non-blank lines; data starts at `lines[1]` whatever line the header was
 * detected on (as on the Mac). In `fixed` mode TradingView rows are paired by Trade # (D-16).
 */
export function parseGreenwickMapped(
  lines: readonly { text: string; line: number }[],
  mapping: GreenwickColumnMapping,
  dialect: CsvDialect,
  ctx: ImportContext,
): GreenwickParseOutput {
  if (ctx.compat === "fixed" && mapping.platform === "tradingView") return parseTradingViewPaired(lines, mapping, dialect, ctx);
  const name = GREENWICK_PLATFORM_NAME[mapping.platform];
  const tickets = new GreenwickTicketCounter();
  const rows: ParsedRow<GreenwickMacTrade>[] = [];
  const issues: RowIssue[] = [];
  for (let i = 1; i < lines.length; i++) {
    const { text, line } = lines[i] as { text: string; line: number };
    const trimmed = trimWs(text);
    if (trimmed === "") continue;
    const fields = splitFields(trimmed, dialect);
    if (fields.length < 4) {
      issues.push({ line, code: "too_few_columns", reason: `Only ${fields.length} column(s)` });
      continue;
    }
    const ticket = tickets.ticket(`${name}|${fields.join("|")}`);
    try {
      const mapped = mapToTrade(fields, mapping, ticket, ctx.now);
      const ext = at(fields, mapping.ticket);
      rows.push({
        trade: mapped.trade,
        meta: {
          source: GREENWICK_PLATFORM_SOURCE[mapping.platform],
          line,
          externalId: ext !== undefined && ext !== "" ? ext.slice(0, 64) : null,
          maeKnown: mapped.maeKnown,
          mfeKnown: mapped.mfeKnown,
          strategyKnown: false,
          timeBasis: "utc",
        },
      });
    } catch (e) {
      /* c8 ignore next */
      if (!(e instanceof RowError)) throw e;
      issues.push({ line, ...e.issue });
    }
  }
  return { rows, issues, optionsSkipped: 0 };
}

/** PARITY D-16 for Greenwick: Entry/Exit rows paired by Trade #. Ticket = FNV over both rows. */
function parseTradingViewPaired(
  lines: readonly { text: string; line: number }[],
  mapping: GreenwickColumnMapping,
  dialect: CsvDialect,
  ctx: ImportContext,
): GreenwickParseOutput {
  const header = lowerTrim(splitFields(lines[0]?.text ?? "", dialect));
  const noIdx = header.indexOf("trade #");
  const issues: RowIssue[] = [];
  const groups = new Map<string, { entry?: { fields: string[]; line: number }; exit?: { fields: string[]; line: number }; order: number }>();
  let order = 0;
  for (let i = 1; i < lines.length; i++) {
    const { text, line } = lines[i] as { text: string; line: number };
    const trimmed = trimWs(text);
    if (trimmed === "") continue;
    const fields = splitFields(trimmed, dialect);
    if (fields.length < 4) {
      issues.push({ line, code: "too_few_columns", reason: `Only ${fields.length} column(s)` });
      continue;
    }
    const no = fields[noIdx] ?? "";
    const type = (fields[mapping.direction] ?? "").toUpperCase();
    const isEntry = type.includes("ENTRY");
    if (!isEntry && !type.includes("EXIT")) {
      issues.push({ line, code: "not_a_trade", reason: `Type "${type.slice(0, 40)}" is neither an entry nor an exit` });
      continue;
    }
    const g = groups.get(no) ?? { order: order++ };
    groups.set(no, g);
    if (isEntry) g.entry = { fields, line };
    else g.exit = { fields, line };
  }
  const tickets = new GreenwickTicketCounter();
  const rows: ParsedRow<GreenwickMacTrade>[] = [];
  for (const [no, g] of [...groups.entries()].sort((a, b) => a[1].order - b[1].order)) {
    if (!g.entry || !g.exit) {
      const line = (g.entry ?? g.exit)?.line ?? null;
      issues.push({ line, code: "unpaired", reason: `Trade #${no.slice(0, 20)} has no ${g.entry ? "exit" : "entry"} row (still open?)` });
      continue;
    }
    const ticket = tickets.ticket(`TradingView|${g.entry.fields.join("|")}|${g.exit.fields.join("|")}`);
    let entry: Mapped;
    let exit: Mapped;
    try {
      entry = mapToTrade(g.entry.fields, mapping, ticket, ctx.now);
      exit = mapToTrade(g.exit.fields, mapping, ticket, ctx.now);
    } catch (e) {
      /* c8 ignore next */
      if (!(e instanceof RowError)) throw e;
      issues.push({ line: g.entry.line, ...e.issue });
      continue;
    }
    const t = entry.trade;
    t.closeTime = exit.trade.openTime;
    t.closePrice = exit.trade.openPrice;
    t.netProfit = exit.trade.netProfit;
    Object.assign(t, greenwickTimeFields(t.openTime, t.closeTime));
    t.maePoints = exit.trade.maePoints;
    t.mfePoints = exit.trade.mfePoints;
    const r = greenwickSlDistAndR(t.openPrice, t.sl, t.netProfit, t.shares);
    t.slDistPoints = r.slDistPoints;
    t.rMultiple = r.rMultiple;
    rows.push({
      trade: t,
      meta: { source: "tradingview", line: g.entry.line, externalId: no === "" ? null : no.slice(0, 64), maeKnown: exit.maeKnown, mfeKnown: exit.mfeKnown, strategyKnown: false, timeBasis: "utc" },
    });
  }
  return { rows, issues, optionsSkipped: 0 };
}
