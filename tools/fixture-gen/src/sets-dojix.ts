// Dojix (forex) fixture sets F1–F9.
import { breakTies, cents, FX_TIE_KEYS, type FxTrade, fileSession, generateFx, money } from "./fx.ts";
import { crlf, encodeText, row } from "./encode.ts";
import * as F from "./formats-dojix.ts";
import { fxJournal, rawJournal } from "./journal.ts";
import { HOUR, MIN, partsUTC, utc, weekdayName } from "./time.ts";
import type { Fixture, Variant } from "./types.ts";

const text = (s: string): Uint8Array => encodeText(s, "utf8");

let nextTicket = 61_000_001;

/** A single hand-specified trade with sensible defaults. */
export function fx(p: Partial<FxTrade> & { open: number; minutes?: number; profit: string }): FxTrade {
  const minutes = p.minutes ?? 45;
  const openTime = p.open;
  const closeTime = p.closeTime ?? openTime + minutes * MIN;
  const hour = partsUTC(openTime).h;
  const t: FxTrade = {
    ticket: p.ticket ?? String(nextTicket++),
    symbol: p.symbol ?? "EURUSD",
    direction: p.direction ?? "BUY",
    lots: p.lots ?? 0.1,
    openTime,
    closeTime,
    durationMin: p.durationMin ?? minutes,
    openPrice: p.openPrice ?? "1.08420",
    closePrice: p.closePrice ?? "1.08520",
    sl: p.sl ?? "1.08220",
    tp: p.tp ?? "1.08820",
    netProfit: p.profit,
    maePips: p.maePips ?? 6.5,
    mfePips: p.mfePips ?? 14.2,
    rMultiple: p.rMultiple ?? Number((cents(p.profit) / 2000).toFixed(2)),
    session: p.session ?? fileSession(hour),
    dayOfWeek: p.dayOfWeek ?? weekdayName(openTime),
    hour: p.hour ?? hour,
    rangeSize: p.rangeSize ?? 32.5,
    sweepDepth: p.sweepDepth ?? 2.1,
    usedFVG: p.usedFVG ?? false,
    volRegime: p.volRegime ?? "MED",
    hitBreakeven: p.hitBreakeven ?? false,
    scaledIn: p.scaledIn ?? false,
    magic: p.magic ?? 7001,
    comment: p.comment ?? "fictional",
    timeToMFEMin: p.timeToMFEMin ?? Math.min(minutes, 12),
    slDistPips: p.slDistPips ?? 20,
    slippagePips: p.slippagePips ?? 0.2,
    postClose15m: p.postClose15m ?? 1.5,
    postClose30m: p.postClose30m ?? -2.5,
    biasAtEntry: p.biasAtEntry ?? "WITH",
    notes: p.notes ?? "",
    tags: p.tags ?? "",
    emotion: p.emotion ?? "",
    checklistData: p.checklistData ?? "",
    commission: p.commission ?? "0",
    swap: p.swap ?? "0",
  };
  return t;
}

/** Trades with the given profits, one per weekday at 09:15 UTC from a start date, ascending. */
function series(profits: readonly string[], start = utc(2026, 1, 5, 9, 15), symbol = "EURUSD"): FxTrade[] {
  const out: FxTrade[] = [];
  let day = start;
  for (const profit of profits) {
    while ([0, 6].includes(partsUTC(day).wd)) day += 24 * HOUR;
    out.push(fx({ open: day, profit, symbol }));
    day += 24 * HOUR;
  }
  return out;
}

const UTC_ONLY: Variant[] = [{ tz: "UTC", locale: "en_US_POSIX" }];
const TIME_VARIANTS: Variant[] = [
  { tz: "UTC", locale: "en_US_POSIX" },
  { tz: "Europe/Berlin", locale: "en_GB" },
  { tz: "America/New_York", locale: "en_US" },
  { tz: "Asia/Kolkata", locale: "en_IN" },
  { tz: "Asia/Tokyo", locale: "ja_JP" },
];

function file(set: string, name: string, bytes: Uint8Array, format: string, description: string,
  extra: Partial<Fixture> = {}): Fixture {
  return {
    id: `dojix/${name.replace(/\.[a-z0-9]+$/i, "")}`,
    brand: "dojix",
    set,
    path: `dojix/${set}/${name}`,
    kind: "file",
    format,
    description,
    variants: UTC_ONLY,
    components: true,
    compare: true,
    bytes,
    ...extra,
  };
}

function journal(set: string, name: string, body: string, description: string, extra: Partial<Fixture> = {}): Fixture {
  return file(set, name, text(body), "journal", description, { kind: "journal", ...extra });
}

export function dojixFixtures(): Fixture[] {
  nextTicket = 61_000_001;
  const out: Fixture[] = [];

  // ---------------- F1 tiny ----------------
  const tiny = series(["100.00", "50.00", "-30.00", "-20.00", "80.00"]);
  out.push(file("F1", "f1-tiny.csv", text(F.sa32(tiny)), "sa32",
    "Hand-checkable set [100, 50, -30, -20, 80] (ascending close): expectancy 36, maxDD 50, Sharpe 0.6872431934890912, Calmar 3.6"));
  out.push(journal("F1", "f1-tiny-journal.json", fxJournal(tiny), "F1 tiny as stored trades"));

  // ---------------- F2 forex year ----------------
  const year = generateFx({
    seed: "dojix-F2", count: 600, start: utc(2025, 10, 1), end: utc(2026, 9, 25), winRate: 0.5, annotate: true,
  });
  breakTies(year, FX_TIE_KEYS);
  out.push(file("F2", "f2-forex-year.csv", text(F.sa32(year)), "sa32",
    "≈600 trades, 6 pairs, all sessions, unique close times, no tied group totals (32-column file)"));
  out.push(journal("F2", "f2-forex-year-journal.json", fxJournal(year),
    "F2 as stored trades, with tags, emotions, checklist data, commission and swap"));

  // ---------------- F3 edge cases ----------------
  out.push(file("F3", "f3-empty.csv", text(`${F.SA32_HEADER}\n`), "sa32", "Header only: zero trades"));
  out.push(journal("F3", "f3-empty-journal.json", fxJournal([]), "Empty journal"));
  out.push(file("F3", "f3-single.csv", text(F.sa32(series(["42.50"]))), "sa32", "One winning trade"));
  out.push(file("F3", "f3-all-wins.csv", text(F.sa32(series(["10.00", "25.50", "5.25", "60.00", "12.75", "33.10"]))),
    "sa32", "All wins: profit factor +∞, Calmar 10"));
  out.push(file("F3", "f3-all-losses.csv", text(F.sa32(series(["-10.00", "-25.50", "-5.25", "-60.00", "-12.75", "-33.10"]))),
    "sa32", "All losses"));
  out.push(file("F3", "f3-breakevens.csv",
    text(F.sa32(series(["0.00", "15.00", "0.00", "-8.00", "0.00", "22.00", "-4.00", "0.00", "9.00", "0.00", "0.00", "-3.00", "0.00"]))),
    "sa32", "Breakevens in runs and as the last trade (current streak 0); all-breakeven tail"));
  out.push(file("F3", "f3-all-breakeven.csv", text(F.sa32(series(["0.00", "0.00", "0.00", "0.00", "0.00", "0.00"]))),
    "sa32", "Every trade breakeven: win rate 0, PF 0, Sharpe 0"));
  out.push(file("F3", "f3-fifty-percent.csv",
    text(F.sa32(series(["30.00", "-10.00", "25.00", "-10.00", "40.00", "-10.00", "35.00", "-10.00", "20.00", "-10.00", "15.00", "-10.00"]))),
    "sa32", "Exactly 50% win rate with a positive edge (RiskOfRuin D-04)"));

  // Zero SL, JPY pairs, negative slippage
  const jpy = [
    fx({ open: utc(2026, 2, 2, 1, 5), symbol: "USDJPY", openPrice: "151.420", closePrice: "151.620", sl: "151.220", tp: "151.820", profit: "13.21", slDistPips: 20, rMultiple: 1 }),
    fx({ open: utc(2026, 2, 2, 3, 40), symbol: "EURJPY", direction: "SELL", openPrice: "163.880", closePrice: "164.080", sl: "164.080", tp: "163.480", profit: "-13.21", slDistPips: 20, rMultiple: -1, slippagePips: -0.4 }),
    fx({ open: utc(2026, 2, 3, 8, 0), symbol: "GBPJPY", openPrice: "191.050", closePrice: "191.300", sl: "0", tp: "0", profit: "16.40", slDistPips: 0, rMultiple: 0, slippagePips: -1.2 }),
    fx({ open: utc(2026, 2, 3, 13, 30), symbol: "EURUSD", sl: "0", tp: "0", profit: "-7.00", slDistPips: 0, rMultiple: 0 }),
    fx({ open: utc(2026, 2, 4, 15, 0), symbol: "USDJPY", direction: "SELL", openPrice: "150.900", closePrice: "150.650", sl: "151.100", tp: "150.500", profit: "16.55", slDistPips: 20, rMultiple: 1.25 }),
  ];
  out.push(file("F3", "f3-zero-sl-jpy.csv", text(F.sa32(jpy)), "sa32", "JPY pairs (pip ×100), zero SL rows, negative slippage"));

  // Bucket edges: profits on WinLossDistribution edges, R on RMultipleChart edges, durations on
  // DurationAnalysis edges, slippage on SlippageAnalysis edges, efficiency on ExitAnalysis edges,
  // time-to-MFE on TimeToMFE edges.
  const edgeR = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, -2.5, 3];
  const edgeDur = [0, 5, 6, 15, 16, 30, 31, 60, 61, 120, 121];
  const edgeSlip = [0, 0.5, 1, 2, 3, 100, 150, -0.5, 0.25, 1.5, 2.5];
  const edgeProfit = ["500.00", "-500.00", "100.00", "-100.00", "200.00", "-200.00", "300.00", "0.00", "400.00", "-300.00", "250.00"];
  const edgeTtm = [5, 6, 15, 16, 30, 31, 60, 61, 0, 1, 90];
  const edge: FxTrade[] = edgeR.map((r, i) => {
    const dur = edgeDur[i] ?? 10;
    const mfe = 20;
    return fx({
      open: utc(2026, 3, 2 + i, 7 + (i % 12), 0),
      minutes: dur,
      profit: edgeProfit[i] ?? "1.00",
      rMultiple: r,
      slDistPips: 20,
      // efficiency = R×slDist/MFE×100 → 0, 20, 40, 60, 80, 100 edges for the winners
      mfePips: r > 0 ? (r * 20) / ([0.2, 0.4, 0.6, 0.8, 1][i % 5] ?? 1) : mfe,
      maePips: i % 3 === 0 ? 0 : 5,
      slippagePips: edgeSlip[i] ?? 0,
      timeToMFEMin: edgeTtm[i] ?? 0,
      postClose30m: [10, 10.5, 9.99, 0, -1][i % 5] ?? 0,
    });
  });
  out.push(file("F3", "f3-bucket-edges.csv", text(F.sa32(edge)), "sa32",
    "Values exactly on bucket edges (P&L ±maxAbs, R, duration, slippage incl. >100, exit efficiency, time-to-MFE; D-01/02/03)"));

  // Column-count and comma edge rows
  const base = series(["11.00", "-6.00", "7.50", "3.00", "-2.25", "8.80"], utc(2026, 4, 6, 10, 0));
  const fields = base.map((t) => F.sa32Fields(t));
  const [r0, r1, r2, r3, r4, r5] = fields;
  if (!r0 || !r1 || !r2 || !r3 || !r4 || !r5) throw new Error("rows");
  const columnRows = [
    row(r0.slice(0, 26)),
    row(r1.slice(0, 27)),
    row(r2.slice(0, 31)),
    row(r3.map((f, i) => (i === 25 ? "quoted, comment" : f))),
    // Unquoted comma inside Comment: 33 fields, later columns shift on the Mac (D-21)
    r4.map((f, i) => (i === 25 ? "unquoted, comment" : f)).join(","),
    row(r5.slice(0, 25)),
  ];
  out.push(file("F3", "f3-columns.csv", text(`${F.SA32_HEADER}\n${columnRows.join("\n")}\n`), "sa32",
    "26, 27 and 31 columns (padded), a quoted comma, an unquoted comma (D-21) and a too-short 25-column row"));

  // Encodings and line endings — the same three trades
  const enc = series(["12.00", "-4.50", "6.25"], utc(2026, 4, 13, 11, 0)).map((t, i) =>
    i === 1 ? { ...t, comment: "Café crème" } : t);
  const encText = F.sa32(enc);
  out.push(file("F3", "f3-enc-lf.csv", encodeText(encText, "utf8"), "sa32", "UTF-8, LF"));
  out.push(file("F3", "f3-enc-crlf.csv", encodeText(crlf(encText), "utf8"), "sa32", "UTF-8, CRLF"));
  out.push(file("F3", "f3-enc-utf8-bom.csv", encodeText(encText, "utf8-bom"), "sa32", "UTF-8 with BOM before the header"));
  out.push(file("F3", "f3-enc-utf16le-bom.csv", encodeText(crlf(encText), "utf16le-bom"), "sa32", "UTF-16LE with BOM, CRLF"));
  out.push(file("F3", "f3-enc-cp1252.csv", encodeText(encText, "cp1252"), "sa32", "Windows-1252 (é is not valid UTF-8)"));

  // Multi-section export: routed by file name on the Mac; the same bytes under another name
  const multi = series(["14.00", "-9.00", "21.00", "-3.50"], utc(2026, 4, 20, 8, 30));
  const multiText = F.sa32(multi, {
    preamble: ["SECTION 1: SUMMARY (fictional)", "Metric,Value", "Trades,4", "Net,22.50", "",
      "SECTION 2: BY SESSION", "Session,Trades,Net", "LONDON,2,5.00", "", "SECTION 3: TRADE DETAIL"],
    postamble: ["SECTION 4: NOTES", "Generated for tests,fictional"],
  });
  out.push(file("F3", "StrategyAnalytics_f3-multisection.csv", text(multiText), "sa32",
    "Multi-section export named like the analysis script's output (Mac routes by file name)"));
  out.push(file("F3", "f3-renamed-multisection.csv", text(multiText), "sa32",
    "Same bytes, renamed: the Mac only looks at line 1, so it falls back to column mapping"));

  // Trade+Sanitize limits (and hostile text)
  const longSymbol = "EURUSD".repeat(7); // 42 characters
  const longComment = "x".repeat(300);
  const hostile = [
    fx({ open: utc(2026, 5, 4, 9, 0), profit: "2000000000000.00", comment: "money above +1e12" }),
    fx({ open: utc(2026, 5, 4, 10, 0), profit: "-5000000000000.50", comment: "money below -1e12" }),
    fx({ open: utc(2026, 5, 4, 11, 0), profit: "999999999999.99", comment: "money just under the limit" }),
    fx({ open: utc(2026, 5, 5, 9, 0), profit: "5.00", maePips: 5e9, mfePips: -3e9, comment: "pips beyond ±1e9" }),
    fx({ open: utc(2026, 5, 5, 10, 0), profit: "6.00", lots: 0.0000001, comment: "lots below the floor" }),
    fx({ open: utc(2026, 5, 5, 11, 0), profit: "7.00", lots: 5000000, comment: "lots above 1e6" }),
    fx({ open: utc(2026, 5, 6, 9, 0), profit: "8.00", symbol: longSymbol, comment: longComment }),
    fx({ open: utc(2026, 5, 6, 10, 0), profit: "9.00", durationMin: 9999999, timeToMFEMin: -5, comment: "durations out of range" }),
    fx({ open: utc(2026, 5, 6, 11, 0), profit: "10.00", hour: 99, dayOfWeek: "Xyz", comment: "invalid hour and weekday" }),
    fx({ open: utc(2026, 5, 7, 9, 0), closeTime: utc(2026, 5, 7, 8, 0), profit: "11.00", comment: "close before open" }),
    fx({ open: utc(2026, 5, 7, 10, 0), profit: "12.00", lots: 0, comment: "zero lots kept" }),
    fx({ open: utc(2026, 5, 7, 11, 0), profit: "13.00", ticket: "9223372036854775807", comment: "largest Int64 ticket" }),
  ];
  const hostileRows = [
    // Non-numeric metrics: "nan", "inf", "-inf" (Swift's Double() accepts them)
    row(F.sa32Fields(fx({ open: utc(2026, 5, 8, 9, 0), profit: "14.00" })).map((f, i) =>
      i === 12 ? "nan" : i === 13 ? "inf" : i === 14 ? "-inf" : i === 25 ? "non-finite metrics" : f)),
    row(F.sa32Fields(fx({ open: utc(2026, 5, 8, 10, 0), profit: "15.00" })).map((f, i) =>
      i === 25 ? "control\u0007chars\u0001here" : f)),
    row(F.sa32Fields(fx({ open: utc(2026, 5, 8, 11, 0), profit: "16.00" })).map((f, i) =>
      i === 1 ? "eurusd" : i === 25 ? "Ünïcødé ✓ 日本語 🚀" : f)),
    row(F.sa32Fields(fx({ open: utc(2026, 5, 8, 12, 0), profit: "17.00" })).map((f, i) =>
      i === 0 ? "not-a-ticket" : f)),
    row(F.sa32Fields(fx({ open: utc(2026, 5, 8, 13, 0), profit: "18.00" })).map((f, i) =>
      i === 4 ? "2026-05-08 13:00:00" : f)),
    row(F.sa32Fields(fx({ open: utc(2026, 5, 8, 14, 0), profit: "19.00" })).map((f, i) =>
      i === 2 ? "HOLD" : f)),
  ];
  out.push(file("F3", "f3-sanitize-limits.csv", text(F.sa32(hostile, { extraRows: hostileRows })), "sa32",
    "Trade+Sanitize limits: ±1e12 money, ±1e9 pips, lots floor/ceiling, 32/256 characters, durations, hour/day recompute, close<open, nan/inf, control characters, Unicode, bad ticket/date/direction rows"));
  out.push(journal("F3", "f3-sanitize-journal.json", rawJournal("dojix", [
    { ...jsonTrade(fx({ open: utc(2026, 5, 11, 9, 0), profit: "1.00" })), maePips: "NaN", rMultiple: "Infinity", comment: "non-finite stored values" },
    { ...jsonTrade(fx({ open: utc(2026, 5, 11, 10, 0), profit: "1e13" })), comment: "money 1e13" },
    { ...jsonTrade(fx({ open: utc(2026, 5, 11, 11, 0), profit: "2.00" })), symbol: "", comment: "empty symbol" },
    { ...jsonTrade(fx({ open: utc(2026, 5, 11, 12, 0), profit: "3.00" })), notes: "tab\tand\nnewline kept\u0007bell", tags: "a\u0001b", comment: "control characters in notes/tags" },
    { ...jsonTrade(fx({ open: utc(2026, 5, 11, 13, 0), profit: "4.00" })), lots: -0.5, comment: "negative lots" },
  ]), "Stored values outside Trade+Sanitize ranges (journal path: clamped on insert)"));

  // ---------------- F4 long history ----------------
  const long = generateFx({
    seed: "dojix-F4", count: 420, start: utc(2025, 11, 3), end: utc(2026, 8, 28),
    winRateAt: (i, n) => (i < n / 2 ? 0.62 : 0.36),
    hourWeights: [1, 2, 3, 7, 8, 8, 9, 9, 10, 12, 13, 13, 14, 14, 15, 16, 17, 20, 21, 22],
    losingHours: [20, 21, 22],
    annotate: true,
  });
  // Regime shift: second half mostly HIGH volatility
  long.forEach((t, i) => {
    if (i >= long.length / 2 && i % 4 !== 0) t.volRegime = "HIGH";
    else if (i < long.length / 2 && i % 3 !== 0) t.volRegime = "LOW";
  });
  breakTies(long, FX_TIE_KEYS);
  out.push(file("F4", "f4-long-history.csv", text(F.sa32(long)), "sa32",
    "420 trades: ≥60 per window, decaying edge, volatility regime shift, losing late hours (EdgeDecay, KillZone, WhatToCut)"));
  out.push(journal("F4", "f4-long-history-journal.json", fxJournal(long), "F4 as stored trades with annotations"));

  // ---------------- F5 one file per format ----------------
  const fmtTrades = generateFx({ seed: "dojix-F5", count: 12, start: utc(2026, 6, 1), end: utc(2026, 6, 26), annotate: true });
  const dup = fmtTrades[3];
  const withDup = dup ? [...fmtTrades, { ...dup }] : fmtTrades; // a genuine identical twin row
  out.push(file("F5", "f5-mt4.csv", text(F.mt4(withDup, [
    row(["0", "2026.06.02 09:00:00", "buy", "0.10", "eurusd", "1.08000", "0", "0", "2026.06.02 10:00:00", "1.08100", "0.00", "0.00", "0", "10.00"]),
    row(["0", "2026.06.02 09:00:00", "buy", "0.10", "eurusd", "1.08000", "0", "0", "2026.06.02 10:00:00", "1.08100", "0.00", "0.00", "0", "10.00"]),
    row(["51999999", "2026.06.03 00:00:00", "balance", "", "", "", "", "", "", "", "", "", "", "1000.00"]),
  ])), "mt4", "MT4 statement: broker tickets, a ticket-0 pair (content tickets + occurrence), a balance row (skipped)"));
  out.push(file("F5", "f5-ctrader.csv", text(F.ctrader(fmtTrades)), "ctrader", "cTrader: volume in units (D-15)"));
  out.push(file("F5", "f5-ctrader-compact.csv", text(F.ctrader(fmtTrades, "compact")), "ctrader",
    "cTrader with the compact header variant (PositionId/EntryPrice)"));
  out.push(file("F5", "f5-tradingview.csv", text(F.tradingView(withDup)), "tradingview",
    "TradingView list of trades: entry and exit rows (D-16), Trade # restarts, ticketless"));
  out.push(file("F5", "f5-oanda.csv", text(F.oanda(fmtTrades)), "oanda", "OANDA statement: units (D-15), financing as swap"));
  out.push(file("F5", "f5-ibkr.csv", text(F.ibkr(fmtTrades)), "ibkr", "Interactive Brokers: quoted Date/Time with a comma"));
  out.push(file("F5", "f5-tos.csv", text(F.tos(withDup)), "tos", "thinkorswim: ticketless, identical twin rows"));
  out.push(file("F5", "f5-ninjatrader.csv", text(F.ninjaTrader(withDup)), "ninjatrader",
    "NinjaTrader: Trade # ignored, content tickets"));
  out.push(file("F5", "f5-generic-unknown.csv", text(F.genericUnknown(fmtTrades)), "generic",
    "Unrecognised header: the Mac shows the column-mapping sheet (no trades without a mapping)"));
  out.push(file("F5", "DojixExport_00000000_20260630.csv", text(F.dojixExport(fmtTrades)), "dojix_export",
    "DojixExport.mq5 output (desktop format): 32 columns + 5, UTC, empty strategy fields"));
  out.push(file("F5", "ReportHistory-00000000.html", encodeText(F.mt5ReportHtml(fmtTrades), "utf16le-bom"), "mt5_report",
    "MT5 Account History report, UTF-16LE (desktop format; the Mac can't read it)"));
  out.push(file("F5", "f5-sa32.csv", text(F.sa32(fmtTrades)), "sa32", "The same trades in the 32-column format"));

  // ---------------- F7 time ----------------
  const boundary: FxTrade[] = [];
  const marks: [number, number, number][] = [
    [2026, 3, 6], [2026, 3, 9], [2026, 3, 27], [2026, 3, 30], [2026, 10, 23], [2026, 10, 26], [2026, 10, 30], [2026, 11, 2],
  ];
  for (const [y, m, d] of marks) {
    for (const [h, mi] of [[0, 10], [5, 25], [18, 40], [22, 50], [23, 30]] as const) {
      const profit = money(((y * 7 + m * 31 + d * 13 + h * 3 + mi) % 4000) - 1500);
      boundary.push(fx({ open: utc(y, m, d, h, mi), minutes: 25, profit }));
    }
  }
  // Sunday/Saturday opens (weekend), week-start boundary
  boundary.push(fx({ open: utc(2026, 3, 1, 22, 5), minutes: 30, profit: "12.34" }));
  boundary.push(fx({ open: utc(2026, 3, 7, 23, 55), minutes: 10, profit: "-5.67" }));
  boundary.sort((a, b) => a.closeTime - b.closeTime);
  out.push(file("F7", "f7-dst-boundaries.csv", text(F.sa32(boundary)), "sa32",
    "Trades around midnight UTC on the US (2026-03-08, 2026-11-01) and EU (2026-03-29, 2026-10-25) switch weeks; run in several zones/locales",
    { variants: TIME_VARIANTS }));
  out.push(file("F7", "f7-ctrader-utc.csv", text(F.ctrader(boundary)), "ctrader",
    "Same instants via a generic import: session/hour/day derived from UTC", { variants: TIME_VARIANTS }));

  // ---------------- F8 tie traps (desktop tie-break only) ----------------
  const ties = series(["10.00", "-10.00", "10.00", "-10.00", "5.00", "5.00", "-5.00", "-5.00", "20.00", "20.00"],
    utc(2026, 7, 6, 9, 0));
  ties.forEach((t, i) => {
    t.symbol = i % 2 ? "GBPUSD" : "EURUSD";
    t.hour = i % 2 ? 9 : 14;
    t.session = fileSession(t.hour);
  });
  out.push(file("F8", "f8-tie-traps.csv", text(F.sa32(ties)), "sa32",
    "Equal group totals everywhere: Swift order is not defined — only the desktop's tie-break is tested", { compare: false }));

  return out;
}

/** JSON shape of one trade in a journal fixture. */
function jsonTrade(t: FxTrade): Record<string, unknown> {
  return { ...t, openTime: new Date(t.openTime * 1000).toISOString(), closeTime: new Date(t.closeTime * 1000).toISOString() };
}

/** F9 scale sets: generated on demand, never committed (see README). */
export function dojixScale(count: number): Fixture {
  const trades = generateFx({ seed: `dojix-F9-${count}`, count, start: utc(2016, 1, 4), end: utc(2026, 9, 25) });
  return file("F9", `f9-scale-${count / 1000}k.csv`, text(F.sa32(trades)), "sa32",
    `${count} trades for performance and save-cost budgets (metrics only)`, { components: false, committed: false });
}
