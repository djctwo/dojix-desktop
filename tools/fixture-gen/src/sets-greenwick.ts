// Greenwick (stocks) fixture sets F1–F9.
import { cents, money } from "./fx.ts";
import { crlf, encodeText, row } from "./encode.ts";
import * as G from "./formats-greenwick.ts";
import { rawJournal, stJournal } from "./journal.ts";
import { breakStTies, etSession, etWeekday, generateSt, ST_TIE_KEYS, type StTrade, type Txn } from "./st.ts";
import { DAY, MIN, et, partsET } from "./time.ts";
import type { Fixture, Variant } from "./types.ts";

const text = (s: string): Uint8Array => encodeText(s, "utf8");
let nextTicket = 4_200_001;

export function st(p: Partial<StTrade> & { open: number; minutes?: number; profit: string }): StTrade {
  const minutes = p.minutes ?? 30;
  const closeTime = p.closeTime ?? p.open + minutes * MIN;
  return {
    ticket: p.ticket ?? String(nextTicket++),
    symbol: p.symbol ?? "FIXA",
    direction: p.direction ?? "BUY",
    shares: p.shares ?? 100,
    openTime: p.open,
    closeTime,
    durationMin: p.durationMin ?? minutes,
    openPrice: p.openPrice ?? "42.00",
    closePrice: p.closePrice ?? "42.50",
    sl: p.sl ?? "41.50",
    tp: p.tp ?? "43.00",
    netProfit: p.profit,
    maePoints: p.maePoints ?? 0.12,
    mfePoints: p.mfePoints ?? 0.6,
    rMultiple: p.rMultiple ?? Number((cents(p.profit) / 5000).toFixed(2)),
    session: p.session ?? etSession(p.open),
    dayOfWeek: p.dayOfWeek ?? etWeekday(p.open),
    hour: p.hour ?? partsET(p.open).h,
    rangeSize: p.rangeSize ?? 0.85,
    hitBreakeven: p.hitBreakeven ?? false,
    scaledIn: p.scaledIn ?? false,
    comment: p.comment ?? "fictional",
    timeToMFEMin: p.timeToMFEMin ?? Math.min(minutes, 8),
    slDistPoints: p.slDistPoints ?? 0.5,
    slippagePoints: p.slippagePoints ?? 0.02,
    sector: p.sector ?? "Technology",
    industry: p.industry ?? "Software",
    volume: p.volume ?? 1_200_000,
    avgVolume: p.avgVolume ?? 1_000_000,
    notes: p.notes ?? "",
    tags: p.tags ?? "",
    emotion: p.emotion ?? "",
    checklistData: p.checklistData ?? "",
    commission: p.commission ?? "0",
    swap: p.swap ?? "0",
    isSample: false,
  };
}

/** One trade per ET trading day at 10:05, ascending. */
function series(profits: readonly string[], start: [number, number, number] = [2026, 1, 5]): StTrade[] {
  const out: StTrade[] = [];
  let noon = et(start[0], start[1], start[2], 12);
  for (const profit of profits) {
    while ([0, 6].includes(partsET(noon).wd)) noon += DAY;
    const p = partsET(noon);
    out.push(st({ open: et(p.y, p.m, p.d, 10, 5), profit }));
    noon += DAY;
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
    id: `greenwick/${name.replace(/\.[a-z0-9]+$/i, "")}`,
    brand: "greenwick",
    set,
    path: `greenwick/${set}/${name}`,
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

const txn = (symbol: string, side: "BUY" | "SELL", shares: number, price: string, time: number,
  commission = "0", fees = "0", extra: Partial<Txn> = {}): Txn => ({ symbol, side, shares, price, time, commission, fees, ...extra });

/** FIFO scenarios shared by every transaction format (dates are ET). */
function fifoScenarios(withTimes: boolean): Txn[] {
  const d = (m: number, day: number, h = 10, mi = 0): number => (withTimes ? et(2026, m, day, h, mi) : et(2026, m, day));
  return [
    // 1 → n: one buy closed by two sells
    txn("FIXA", "BUY", 100, "10.00", d(2, 2, 9, 45), "1.00", "0.05"),
    txn("FIXA", "SELL", 50, "11.00", d(2, 3, 10, 15), "0.50", "0.02"),
    txn("FIXA", "SELL", 50, "12.00", d(2, 4, 11, 0), "0.50", "0.02"),
    // n → 1: two buys closed by one sell
    txn("FIXB", "BUY", 30, "20.00", d(2, 9, 9, 50), "0.30"),
    txn("FIXB", "BUY", 70, "21.00", d(2, 10, 10, 30), "0.70"),
    txn("FIXB", "SELL", 100, "22.00", d(2, 11, 14, 5), "1.00", "0.10"),
    // Short: sell first, buy to cover later
    txn("FIXC", "SELL", 40, "15.00", d(2, 16, 10, 0), "0.40"),
    txn("FIXC", "BUY", 40, "14.00", d(2, 18, 15, 30), "0.40"),
    // Partial: 40 shares stay open (unmatched buy)
    txn("FIXD", "BUY", 100, "5.00", d(2, 23, 9, 35)),
    txn("FIXD", "SELL", 60, "6.00", d(2, 24, 9, 40)),
    // Same day: sell then buy (a short on a date-only export, D-26)
    txn("FIXE", "SELL", 25, "30.00", d(3, 3, 9, 31)),
    txn("FIXE", "BUY", 25, "29.00", d(3, 3, 15, 59)),
    // Same timestamp buy and sell
    txn("FIX.B", "BUY", 10, "300.00", d(3, 5, 12, 0)),
    txn("FIX.B", "SELL", 10, "301.25", d(3, 5, 12, 0)),
    // Fractional shares
    txn("FIXA", "BUY", 0.5, "10.10", d(3, 9, 10, 0)),
    txn("FIXA", "SELL", 0.5, "10.40", d(3, 10, 10, 0)),
    // Unmatched sell (no buy before or after)
    txn("FIXF", "SELL", 10, "9.00", d(3, 12, 10, 0)),
  ];
}

export function greenwickFixtures(): Fixture[] {
  nextTicket = 4_200_001;
  const out: Fixture[] = [];

  // ---------------- F1 tiny ----------------
  const tiny = series(["100.00", "50.00", "-30.00", "-20.00", "80.00"]);
  out.push(journal("F1", "f1-tiny-journal.json", stJournal(tiny),
    "Hand-checkable set [100, 50, -30, -20, 80] (ascending close) as stored trades"));
  out.push(file("F1", "f1-tiny-ninjatrader.csv", text(G.ninjaTrader(tiny)), "ninjatrader", "F1 tiny via a matched-trade import"));

  // ---------------- F2 stocks year ----------------
  const year = generateSt({ seed: "greenwick-F2", count: 520, start: [2025, 10, 1], days: 358, annotate: true });
  breakStTies(year, ST_TIE_KEYS);
  out.push(journal("F2", "f2-stocks-year-journal.json", stJournal(year),
    "≈520 trades, 6 fictional tickers incl. a dotted one and an unknown sector, all ET sessions, unique close times, no tied totals"));
  out.push(file("F2", "f2-stocks-year-ninjatrader.csv", text(G.ninjaTrader(year)), "ninjatrader", "F2 via a matched-trade import"));

  // ---------------- F3 edge cases ----------------
  out.push(journal("F3", "f3-empty-journal.json", stJournal([]), "Empty journal"));
  out.push(file("F3", "f3-empty-ninjatrader.csv", text(G.ninjaTrader([])), "ninjatrader", "Header only"));
  out.push(journal("F3", "f3-single-journal.json", stJournal(series(["42.50"])), "One winning trade"));
  out.push(journal("F3", "f3-all-wins-journal.json", stJournal(series(["10.00", "25.50", "5.25", "60.00", "12.75", "33.10"])), "All wins"));
  out.push(journal("F3", "f3-all-losses-journal.json", stJournal(series(["-10.00", "-25.50", "-5.25", "-60.00", "-12.75", "-33.10"])), "All losses"));
  out.push(journal("F3", "f3-breakevens-journal.json",
    stJournal(series(["0.00", "15.00", "0.00", "-8.00", "0.00", "22.00", "-4.00", "0.00", "9.00", "0.00", "0.00", "-3.00", "0.00"])),
    "Breakevens in runs and as the last trade"));
  out.push(journal("F3", "f3-fifty-percent-journal.json",
    stJournal(series(["30.00", "-10.00", "25.00", "-10.00", "40.00", "-10.00", "35.00", "-10.00", "20.00", "-10.00", "15.00", "-10.00"])),
    "Exactly 50% win rate with a positive edge (D-04)"));

  // Bucket edges: RVOL, opening-range minutes, slippage, durations, R, time-to-MFE
  const rvol = [0.5, 1.5, 3, 0.49, 1.51, 2.99, 1000, 0, 0.75, 2];
  const orMinutes = [0, 5, 15, 30, 120, 210, 330, 390, 4, 29];
  const slip = [0, 0.5, 1, 2, 3, 100, 150, 0.25, 1.5, 2.5];
  const rs = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
  const edges = rvol.map((v, i) => {
    const day = et(2026, 3, 2 + i * 2, 9, 30) + (orMinutes[i] ?? 0) * MIN;
    return st({
      open: day, minutes: [0, 5, 6, 15, 16, 30, 31, 60, 61, 121][i] ?? 10,
      profit: ["500.00", "-500.00", "100.00", "-100.00", "0.00", "200.00", "-200.00", "300.00", "400.00", "-300.00"][i] ?? "1.00",
      rMultiple: rs[i] ?? 0, slippagePoints: slip[i] ?? 0, volume: Math.round(v * 1_000_000), avgVolume: v === 0 ? 0 : 1_000_000,
      timeToMFEMin: [5, 6, 15, 16, 30, 31, 60, 61, 0, 90][i] ?? 0,
    });
  });
  out.push(journal("F3", "f3-bucket-edges-journal.json", stJournal(edges),
    "Values on bucket edges: RVOL 0.5/1.5/3, opening-range minutes, slippage incl. >100, durations, R, time-to-MFE, avgVolume 0"));

  // TradeLimits rejections (journal path rejects the row)
  const okRow = (open: number, profit: string): Record<string, unknown> => {
    const t = st({ open, profit });
    return { ...t, openTime: new Date(t.openTime * 1000).toISOString(), closeTime: new Date(t.closeTime * 1000).toISOString() };
  };
  out.push(journal("F3", "f3-trade-limits-journal.json", rawJournal("greenwick", [
    { ...okRow(et(2026, 4, 6, 10), "5.00"), comment: "valid" },
    { ...okRow(et(2026, 4, 6, 11), "5.00"), shares: 0.0000001, comment: "shares below 1e-6" },
    { ...okRow(et(2026, 4, 6, 12), "5.00"), shares: 2e9, comment: "shares above 1e9" },
    { ...okRow(et(2026, 4, 6, 13), "2000000000000"), comment: "amount above 1e12" },
    { ...okRow(et(2026, 4, 6, 14), "5.00"), durationMin: 20 * 366 * 24 * 60 + 1, comment: "duration above 20 years" },
    { ...okRow(et(2026, 4, 7, 10), "5.00"), openTime: "1899-12-31T00:00:00.000Z", comment: "date before 1900" },
    { ...okRow(et(2026, 4, 7, 11), "5.00"), closeTime: "2200-01-02T00:00:00.000Z", comment: "date after 2200" },
    { ...okRow(et(2026, 4, 7, 12), "5.00"), symbol: "X".repeat(33), comment: "symbol of 33 characters" },
    { ...okRow(et(2026, 4, 7, 13), "5.00"), hour: 24, comment: "hour 24" },
    { ...okRow(et(2026, 4, 7, 14), "5.00"), ticket: "0", comment: "ticket 0" },
    { ...okRow(et(2026, 4, 8, 10), "5.00"), maePoints: "NaN", comment: "non-finite points" },
    { ...okRow(et(2026, 4, 8, 11), "5.00"), sector: "S".repeat(201), comment: "label of 201 characters" },
    { ...okRow(et(2026, 4, 8, 12), "5.00"), notes: "keeps\ttab and\nnewline\u0007drops bell and LS", comment: "control characters stripped" },
    { ...okRow(et(2026, 4, 8, 13), "5.00"), volume: 1e12 + 1, comment: "volume above 1e12" },
    { ...okRow(et(2026, 4, 8, 14), "-999999999999.99"), comment: "amount just inside the limit" },
  ]), "TradeLimits: each row breaks one rule (rejected), plus valid and boundary rows"));

  const hostile = series(["11.00", "-6.00", "7.50"], [2026, 4, 13]);
  out.push(file("F3", "f3-hostile-ninjatrader.csv", text(G.ninjaTrader(hostile, [
    row(["4", "FIXA", "Sim101", "Fictional", "Long", "inf", "1.00", "2.00", "04/16/2026 10:00:00", "04/16/2026 10:30:00", "1.00", "0", "0", "0"]),
    row(["5", "FIXA", "Sim101", "Fictional", "Long", "100", "nan", "2.00", "04/16/2026 11:00:00", "04/16/2026 11:30:00", "1e308", "0", "0", "0"]),
    row(["6", "averyveryverylongticker", "Sim101", "Fictional", "Long", "10", "1.00", "2.00", "04/16/2026 12:00:00", "04/16/2026 12:30:00", "10.00", "0", "0", "0"]),
    row(["7", "äbc", "Sim101", "Fictional", "Short", "10", "1.00", "0.50", "04/16/2026 13:00:00", "04/16/2026 13:30:00", "5.00", "0", "0", "0"]),
    row(["8", "FIXA", "Sim101", "Fictional", "=cmd|Long", "10", "1.00", "2.00", "04/16/2026 14:00:00", "04/16/2026 14:30:00", "10.00", "-0.65", "0", "0"]),
    row(["9", "FIXA", "Sim101", "Fictional", "Long", "10", "1.00", "2.00", "2026-04-16T15:00:00Z", "16 Apr 2026", "10.00", "0", "0", "0"]),
    row(["10", "FIXA", "Sim101", "Fictional", "Flat", "10", "1.00", "2.00", "04/16/2026 15:30:00", "04/16/2026 15:45:00", "10.00", "0", "0", "0"]),
    row(["11", "FIXA", "Sim101", "Fictional", "Long", "10", "$1,000.50", "(2.00)", "04/16/2026 15:50:00", "04/16/2026 15:55:00", "1,234.56", "0", "0", "0"]),
  ])), "ninjatrader",
    "Hostile values: inf/nan/1e308, long and non-ASCII symbols, formula prefix, ISO and unparseable dates, bad direction, currency formatting"));

  const enc = series(["12.00", "-4.50", "6.25"], [2026, 4, 20]);
  const encText = G.ninjaTrader(enc).replace("Fictional", "Café");
  out.push(file("F3", "f3-enc-crlf.csv", encodeText(crlf(encText), "utf8"), "ninjatrader", "UTF-8, CRLF"));
  out.push(file("F3", "f3-enc-utf8-bom.csv", encodeText(encText, "utf8-bom"), "ninjatrader", "UTF-8 with BOM"));
  out.push(file("F3", "f3-enc-utf16le-bom.csv", encodeText(crlf(encText), "utf16le-bom"), "ninjatrader",
    "UTF-16LE with BOM (the Mac has no UTF-16 path)"));
  out.push(file("F3", "f3-enc-cp1252.csv", encodeText(encText, "cp1252"), "ninjatrader", "Windows-1252"));

  // ---------------- F4 long history ----------------
  const long = generateSt({
    seed: "greenwick-F4", count: 400, start: [2025, 11, 3], days: 300, annotate: true,
    winRateAt: (i, n) => (i < n / 2 ? 0.62 : 0.38),
  });
  breakStTies(long, ST_TIE_KEYS);
  out.push(journal("F4", "f4-long-history-journal.json", stJournal(long),
    "400 trades: ≥60 per window, decaying edge (EdgeDecay, KillZone, WhatToCut, Regime)"));

  // ---------------- F5 one file per format ----------------
  const fmtTrades = generateSt({ seed: "greenwick-F5", count: 12, start: [2026, 6, 1], days: 25 });
  const dup = fmtTrades[2];
  const withDup = dup ? [...fmtTrades, { ...dup }] : fmtTrades;
  out.push(file("F5", "f5-ibkr.csv", text(G.ibkr(withDup)), "ibkr", "Interactive Brokers: signed quantity, quoted Date/Time"));
  out.push(file("F5", "f5-tos.csv", text(G.tos(withDup)), "tos", "thinkorswim, with identical twin rows"));
  out.push(file("F5", "f5-tradingview.csv", text(G.tradingView(fmtTrades)), "tradingview", "TradingView entry/exit rows (D-16)"));
  out.push(file("F5", "f5-ninjatrader.csv", text(G.ninjaTrader(withDup)), "ninjatrader", "NinjaTrader with an identical twin row"));
  out.push(file("F5", "f5-webull.csv", text(G.webull(fmtTrades, false, [
    row(["Fictional Co X", "FIXA", "Buy", "Filled", "10", "10", "@10.00", "10.00", "DAY", "06/30/2026 10:00:00 EDT", "06/30/2026 10:00:00 EDT"]),
  ])), "webull", "Webull orders without a P&L column; a row with a zone suffix on the time"));
  out.push(file("F5", "f5-webull-pnl.csv", text(G.webull(fmtTrades, true)), "webull", "Webull with Realized P&L and Commission"));
  out.push(file("F5", "f5-generic-unknown.csv", text(G.genericUnknown(fmtTrades)), "generic",
    "Unrecognised header: column mapping on the Mac"));
  const roundTrips: Txn[] = fmtTrades.flatMap((t) => [
    txn(t.symbol, t.direction, t.shares, t.openPrice, t.openTime, (Number(t.commission) / 2).toFixed(2)),
    txn(t.symbol, t.direction === "BUY" ? "SELL" : "BUY", t.shares, t.closePrice, t.closeTime, (Number(t.commission) / 2).toFixed(2)),
  ]).sort((a, b) => a.time - b.time);
  out.push(file("F5", "f5-robinhood.csv", text(G.robinhood(roundTrips, false)), "robinhood", "Robinhood activity (date-only)"));
  out.push(file("F5", "f5-schwab.csv", text(G.schwab(roundTrips)), "schwab", "Schwab transactions with metadata line and footer"));
  out.push(file("F5", "f5-fidelity.csv", encodeText(G.fidelity(roundTrips), "utf8-bom"), "fidelity", "Fidelity history, UTF-8 BOM, disclaimers"));
  out.push(file("F5", "f5-etrade.csv", text(G.etrade(roundTrips)), "etrade", "E*Trade (two-digit years)"));
  out.push(file("F5", "f5-tastytrade.csv", text(G.tastytrade(roundTrips)), "tastytrade", "Tastytrade (ISO times)"));

  // ---------------- F6 FIFO ----------------
  const dateOnly = fifoScenarios(false);
  const timed = fifoScenarios(true);
  const options: Txn[] = [
    txn("FIXA", "BUY", 2, "1.25", et(2026, 3, 16), "0.65", "0", { action: "BTO", description: "FIXA 4/17/2026 Call $45.00" }),
    txn("FIXA", "SELL", 2, "1.90", et(2026, 3, 17), "0.65", "0", { action: "STC", description: "FIXA 4/17/2026 Call $45.00" }),
  ];
  out.push(file("F6", "f6-robinhood.csv", text(G.robinhood([...dateOnly, ...options], false)), "robinhood",
    "FIFO: 1→n, n→1, short, partial, same-day sell→buy (D-26), same timestamp, fractional, unmatched sell; option rows BTO/STC (D-22)"));
  out.push(file("F6", "f6-robinhood-fees.csv", text(G.robinhood(dateOnly, true)), "robinhood",
    "Robinhood with a Fees column (the Mac never reads it: D-27)"));
  const schwabTx = [...dateOnly, txn("FIXA", "BUY", 1, "2.00", et(2026, 3, 18), "0.65", "0", { action: "Buy to Open", description: "FIXA 04/17/2026 45.00 C" })];
  out.push(file("F6", "f6-schwab.csv", text(G.schwab(schwabTx)), "schwab", "Schwab with metadata + footer, a Buy to Open option row"));
  out.push(file("F6", "f6-schwab-no-footer.csv", text(G.schwab(dateOnly, { metadata: true, footer: false })), "schwab",
    "Schwab without the footer: the Mac drops the last line (D-23)"));
  out.push(file("F6", "f6-schwab-header-first.csv", text(G.schwab(dateOnly, { metadata: false, footer: true })), "schwab",
    "Schwab with the header on line 0: the Mac finds 0 trades (D-23)"));
  out.push(file("F6", "f6-fidelity.csv", encodeText(G.fidelity(dateOnly), "utf8-bom"), "fidelity",
    "Fidelity: commission and fees on legs"));
  out.push(file("F6", "f6-fidelity-no-price.csv", encodeText(G.fidelity(dateOnly, false), "utf8-bom"), "fidelity",
    "Fidelity without a Price column: the Mac reads column 0 (D-24)"));
  out.push(file("F6", "f6-etrade.csv", text(G.etrade(dateOnly)), "etrade", "E*Trade FIFO scenarios (date-only)"));
  out.push(file("F6", "f6-tastytrade.csv", text(G.tastytrade([...timed,
    txn("FIXB", "BUY", 1, "3.10", et(2026, 3, 19, 10), "1.00", "0.14", { action: "BUY_TO_OPEN", description: "Fictional option" }),
    txn("FIXB", "SELL", 1, "3.60", et(2026, 3, 19, 14), "0", "0.14", { action: "SELL_TO_CLOSE", description: "Fictional option" }),
  ])), "tastytrade", "Tastytrade FIFO scenarios with timestamps; commission and fees on every leg"));

  // ---------------- F7 time ----------------
  const tz: StTrade[] = [];
  const add = (open: number, minutes: number, profit: string, note: string): void => {
    tz.push(st({ open, minutes, profit, comment: note }));
  };
  add(et(2026, 3, 6, 18, 20), 30, "15.00", "Fri after-hours close 18:50 ET (Sat in Berlin/Tokyo)");
  add(et(2026, 3, 6, 19, 50), 9, "-4.00", "Fri 19:59 ET close");
  add(et(2026, 3, 9, 4, 5), 20, "7.25", "Mon pre-market after the US switch");
  add(et(2026, 3, 9, 9, 29), 2, "-1.10", "09:29 → 09:31 straddles the open");
  add(et(2026, 3, 9, 15, 59), 3, "2.00", "15:59 → 16:02 straddles the close");
  add(et(2026, 3, 7, 11, 0), 30, "3.30", "Saturday (EXTENDED)");
  add(et(2026, 3, 27, 23, 50), 20, "-2.20", "Fri 23:50 ET → Sat 00:10 ET");
  add(et(2026, 3, 30, 0, 5), 10, "1.75", "Mon 00:05 ET = 04:05 UTC (ET midnight boundary)");
  add(et(2026, 10, 23, 18, 50), 5, "6.60", "Fri evening before the EU switch");
  add(et(2026, 10, 26, 9, 30), 60, "-8.80", "Mon open after the EU switch, before the US switch");
  add(et(2026, 10, 30, 18, 50), 30, "12.12", "Fri 19:20 ET close, US still on EDT");
  add(et(2026, 11, 2, 9, 31), 29, "-3.03", "Mon after the US switch (EST)");
  add(et(2026, 11, 2, 23, 59), 1, "0.50", "23:59 ET → 00:00 ET next day");
  tz.sort((a, b) => a.closeTime - b.closeTime);
  out.push(journal("F7", "f7-et-boundaries-journal.json", stJournal(tz),
    "ET trading-day, session and DST boundaries (2026-03-08, 2026-11-01, EU 03-29/10-25), Friday-evening closes; run in several zones",
    { variants: TIME_VARIANTS }));
  out.push(file("F7", "f7-et-boundaries-ninjatrader.csv", text(G.ninjaTrader(tz)), "ninjatrader",
    "Same trades through an import (ET wall-clock times)", { variants: TIME_VARIANTS }));

  // ---------------- F8 tie traps ----------------
  const ties = series(["10.00", "-10.00", "10.00", "-10.00", "5.00", "5.00", "-5.00", "-5.00", "20.00", "20.00"], [2026, 7, 6]);
  ties.forEach((t, i) => {
    t.symbol = i % 2 ? "FIXB" : "FIXA";
    t.sector = i % 2 ? "Energy" : "Technology";
  });
  out.push(journal("F8", "f8-tie-traps-journal.json", stJournal(ties),
    "Equal group totals: Swift order undefined — desktop tie-break only", { compare: false }));

  return out;
}

export function greenwickScale(count: number): Fixture {
  const trades = generateSt({ seed: `greenwick-F9-${count}`, count, start: [2016, 1, 4], days: 3900 });
  return file("F9", `f9-scale-${count / 1000}k-ninjatrader.csv`, text(G.ninjaTrader(trades)), "ninjatrader",
    `${count} trades for performance and save-cost budgets (metrics only)`, { components: false, committed: false });
}

export { money };
