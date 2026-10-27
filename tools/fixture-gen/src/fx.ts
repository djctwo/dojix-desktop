// Fictional forex trades for Dojix fixtures. Field names follow the Mac app's `Trade`.
import { Rng } from "./rng.ts";
import { DAY, HOUR, MIN, partsUTC, weekdayName } from "./time.ts";

export type Direction = "BUY" | "SELL";

export interface FxTrade {
  ticket: string;
  symbol: string;
  direction: Direction;
  lots: number;
  openTime: number;
  closeTime: number;
  durationMin: number;
  openPrice: string;
  closePrice: string;
  sl: string;
  tp: string;
  netProfit: string;
  maePips: number;
  mfePips: number;
  rMultiple: number;
  /** Raw session label as written in the 32-column file. */
  session: string;
  dayOfWeek: string;
  hour: number;
  rangeSize: number;
  sweepDepth: number;
  usedFVG: boolean;
  volRegime: "LOW" | "MED" | "HIGH";
  hitBreakeven: boolean;
  scaledIn: boolean;
  magic: number;
  comment: string;
  timeToMFEMin: number;
  slDistPips: number;
  slippagePips: number;
  postClose15m: number;
  postClose30m: number;
  biasAtEntry: "WITH" | "AGAINST" | "NEUTRAL";
  notes: string;
  tags: string;
  emotion: string;
  checklistData: string;
  commission: string;
  swap: string;
}

export const FX_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "EURJPY"] as const;

const BASE_PRICE: Record<string, number> = {
  EURUSD: 1.0842,
  GBPUSD: 1.2715,
  USDJPY: 151.42,
  AUDUSD: 0.6618,
  USDCAD: 1.3604,
  EURJPY: 163.88,
  GBPJPY: 191.05,
  NZDUSD: 0.6012,
};

export const isJpy = (symbol: string): boolean => symbol.includes("JPY");
const pipSize = (symbol: string): number => (isJpy(symbol) ? 0.01 : 0.0001);
const digits = (symbol: string): number => (isJpy(symbol) ? 3 : 5);

/** The 32-column file's own session buckets (UTC hour of the open). */
export function fileSession(hour: number): string {
  if (hour <= 7) return "ASIAN";
  if (hour <= 11) return "LONDON";
  if (hour <= 16) return "NY_OVERLAP";
  if (hour <= 21) return "NY";
  return "LATE";
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function cents(value: string): number {
  const neg = value.startsWith("-");
  const [whole = "0", frac = ""] = value.replace("-", "").split(".");
  const c = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -c : c;
}

const round = (x: number, dp: number): number => Number(x.toFixed(dp));

export interface FxGenOptions {
  seed: string;
  count: number;
  /** First possible open (UTC seconds) */
  start: number;
  /** Last possible open (UTC seconds) */
  end: number;
  pairs?: readonly string[];
  winRate?: number;
  breakevenRate?: number;
  /** Ticket of the first trade; tickets increase by a random step. */
  firstTicket?: number;
  /** Optional per-trade win-rate override (index → probability), e.g. for decaying edge. */
  winRateAt?: (index: number, count: number) => number;
  /** Hours (UTC) to favour, e.g. to build kill zones. */
  hourWeights?: readonly number[];
  /** Hours whose trades lose more often (kill-zone material). */
  losingHours?: readonly number[];
  annotate?: boolean;
  allowWeekend?: boolean;
}

const TAGS = ["breakout", "pullback", "news", "range", "reversal", "trend"] as const;
const EMOTIONS = ["CALM", "CONFIDENT", "ANXIOUS", "FRUSTRATED", "REVENGE", "FOMO", "BORED"] as const;
const RULES = ["Waited for the close", "Risk ≤ 1 %", "Checked the calendar", "Traded with the trend"] as const;

/** Generates fictional trades; close times are unique (whole seconds). */
export function generateFx(opts: FxGenOptions): FxTrade[] {
  const rng = new Rng(opts.seed);
  const pairs = opts.pairs ?? FX_PAIRS;
  const trades: FxTrade[] = [];
  const usedClose = new Set<number>();
  let ticket = opts.firstTicket ?? 51_000_001;
  const span = Math.max(1, Math.floor((opts.end - opts.start) / DAY));

  for (let i = 0; i < opts.count; i++) {
    const symbol = rng.pick(pairs);
    const direction: Direction = rng.chance(0.52) ? "BUY" : "SELL";
    const lots = round(rng.pick([0.01, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 1.5, 2]) * (rng.chance(0.1) ? 2 : 1), 2);

    // Open time: a random weekday, an hour from the weights, a random minute.
    let openTime: number | undefined;
    while (openTime === undefined) {
      const day = opts.start + rng.int(0, span) * DAY;
      const p = partsUTC(day);
      if (!opts.allowWeekend && (p.wd === 0 || p.wd === 6)) continue;
      const hour = opts.hourWeights ? rng.pick(opts.hourWeights) : rng.int(0, 23);
      openTime = day - (p.h * HOUR + p.mi * MIN + p.s) + hour * HOUR + rng.int(0, 59) * MIN + rng.int(0, 59);
    }
    const durationMin = rng.chance(0.08) ? rng.int(0, 5) : rng.chance(0.6) ? rng.int(6, 120) : rng.int(121, 900);
    let closeTime = openTime + durationMin * MIN + rng.int(0, 59);
    while (usedClose.has(closeTime)) closeTime += 1;
    usedClose.add(closeTime);

    const hour = partsUTC(openTime).h;
    const losing = opts.losingHours?.includes(hour) ?? false;
    const baseWin = opts.winRateAt ? opts.winRateAt(i, opts.count) : (opts.winRate ?? 0.5);
    const winP = losing ? baseWin * 0.45 : baseWin;
    const beRate = opts.breakevenRate ?? 0.03;

    const slDistPips = round(8 + rng.float() * 32, 1);
    let r: number;
    const roll = rng.float();
    if (roll < beRate) r = 0;
    else if (roll < beRate + winP) r = round(0.3 + rng.float() * 3.2, 2);
    else r = -round(rng.chance(0.7) ? 1 : 0.2 + rng.float() * 0.8, 2);

    const pipValue = isJpy(symbol) ? 6.6 : 10;
    const riskCents = Math.max(1, Math.round(slDistPips * lots * pipValue * 100));
    let profitCents = Math.round(r * riskCents);
    if (r !== 0 && profitCents === 0) profitCents = r > 0 ? 1 : -1;
    // Spread the cents so group totals rarely tie.
    if (r !== 0) profitCents += (r > 0 ? 1 : -1) * rng.int(0, 99);
    const rMultiple = r === 0 ? 0 : round(profitCents / riskCents, 2);

    const base = (BASE_PRICE[symbol] ?? 1.1) * (1 + (rng.float() - 0.5) * 0.04);
    const pip = pipSize(symbol);
    const sign = direction === "BUY" ? 1 : -1;
    const openPrice = base;
    const movePips = rMultiple * slDistPips;
    const closePrice = openPrice + sign * movePips * pip;
    const sl = openPrice - sign * slDistPips * pip;
    const tp = openPrice + sign * slDistPips * 2 * pip;
    const mfePips = round(Math.max(0, movePips) + rng.float() * slDistPips, 1);
    const maePips = round(Math.max(0, -movePips) + rng.float() * slDistPips * 0.6, 1);

    const trade: FxTrade = {
      ticket: String(ticket),
      symbol,
      direction,
      lots,
      openTime,
      closeTime,
      durationMin,
      openPrice: openPrice.toFixed(digits(symbol)),
      closePrice: closePrice.toFixed(digits(symbol)),
      sl: sl.toFixed(digits(symbol)),
      tp: tp.toFixed(digits(symbol)),
      netProfit: money(profitCents),
      maePips,
      mfePips,
      rMultiple,
      session: fileSession(hour),
      dayOfWeek: weekdayName(openTime),
      hour,
      rangeSize: round(10 + rng.float() * 60, 1),
      sweepDepth: round(rng.float() * 8, 1),
      usedFVG: rng.chance(0.35),
      volRegime: rng.pick(["LOW", "MED", "HIGH"] as const),
      hitBreakeven: rng.chance(0.2),
      scaledIn: rng.chance(0.1),
      magic: 7000 + rng.int(1, 4),
      comment: "fictional",
      timeToMFEMin: rng.chance(0.15) ? 0 : Math.min(durationMin, rng.int(1, Math.max(1, durationMin))),
      slDistPips,
      slippagePips: rng.chance(0.3) ? 0 : round((rng.float() - 0.15) * 3, 1),
      postClose15m: round((rng.float() - 0.4) * 20, 1),
      postClose30m: round((rng.float() - 0.4) * 30, 1),
      biasAtEntry: rng.pick(["WITH", "AGAINST", "NEUTRAL"] as const),
      notes: "",
      tags: "",
      emotion: "",
      checklistData: "",
      commission: "0",
      swap: "0",
    };
    if (opts.annotate) annotate(trade, rng);
    trades.push(trade);
    ticket += rng.int(1, 40);
  }
  trades.sort((a, b) => a.closeTime - b.closeTime);
  return trades;
}

function annotate(t: FxTrade, rng: Rng): void {
  if (rng.chance(0.7)) {
    const n = rng.int(1, 2);
    const tags = new Set<string>();
    for (let k = 0; k < n; k++) tags.add(rng.pick(TAGS));
    t.tags = [...tags].join(",");
  }
  if (rng.chance(0.6)) t.emotion = rng.pick(EMOTIONS);
  if (rng.chance(0.5)) {
    const entries = RULES.map((rule) => `${JSON.stringify(rule)}:${rng.chance(0.75) ? "true" : "false"}`);
    t.checklistData = `{${entries.join(",")}}`;
  }
  if (rng.chance(0.3)) t.notes = "Fictional note.\nSecond line.";
  t.commission = money(Math.round(t.lots * 700));
  t.swap = rng.chance(0.3) ? money(rng.int(-250, 120)) : "0";
}

type Key = (t: FxTrade) => string;

/**
 * Nudges profits by a cent until no two groups share a total in any of the given
 * dimensions, so sorted outputs have no ties (F2's "no tied group totals").
 */
export function breakTies(trades: FxTrade[], keys: readonly Key[]): void {
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    for (const key of keys) {
      const totals = new Map<string, number>();
      const last = new Map<string, FxTrade>();
      for (const t of trades) {
        const k = key(t);
        totals.set(k, (totals.get(k) ?? 0) + cents(t.netProfit));
        last.set(k, t);
      }
      const seen = new Map<number, string>();
      for (const [k, total] of [...totals.entries()].sort()) {
        if (seen.has(total)) {
          const t = last.get(k);
          if (t && cents(t.netProfit) !== 0) {
            const c = cents(t.netProfit);
            t.netProfit = money(c + (c > 0 ? 1 : -1));
            changed = true;
          }
        } else seen.set(total, k);
      }
    }
    if (!changed) return;
  }
  throw new Error("could not break ties");
}

export const FX_TIE_KEYS: readonly Key[] = [
  (t) => String(t.hour),
  (t) => t.session,
  (t) => t.dayOfWeek,
  (t) => t.symbol,
  (t) => t.biasAtEntry,
  (t) => t.volRegime,
  (t) => t.direction,
  (t) => t.tags,
  (t) => t.emotion,
];
