// Fictional stock trades and broker transactions for Greenwick fixtures.
// Tickers are made up (FIXA, FIXB, …) and every amount is invented.
import { Rng } from "./rng.ts";
import { DAY, MIN, et, partsET, WEEKDAYS } from "./time.ts";
import { cents, money } from "./fx.ts";

export type Direction = "BUY" | "SELL";

export interface StTrade {
  ticket: string;
  symbol: string;
  direction: Direction;
  shares: number;
  openTime: number;
  closeTime: number;
  durationMin: number;
  openPrice: string;
  closePrice: string;
  sl: string;
  tp: string;
  netProfit: string;
  maePoints: number;
  mfePoints: number;
  rMultiple: number;
  session: string;
  dayOfWeek: string;
  hour: number;
  rangeSize: number;
  hitBreakeven: boolean;
  scaledIn: boolean;
  comment: string;
  timeToMFEMin: number;
  slDistPoints: number;
  slippagePoints: number;
  sector: string;
  industry: string;
  volume: number;
  avgVolume: number;
  notes: string;
  tags: string;
  emotion: string;
  checklistData: string;
  commission: string;
  swap: string;
  isSample: boolean;
}

export const ST_SYMBOLS: Readonly<Record<string, { price: number; sector: string; industry: string }>> = {
  FIXA: { price: 42.18, sector: "Technology", industry: "Software" },
  FIXB: { price: 118.6, sector: "Technology", industry: "Semiconductors" },
  FIXC: { price: 23.45, sector: "Energy", industry: "Oil & Gas" },
  FIXD: { price: 77.3, sector: "Healthcare", industry: "Biotech" },
  FIXE: { price: 9.87, sector: "Financials", industry: "Banks" },
  "FIX.B": { price: 301.2, sector: "", industry: "" },
};

/** Session of an ET wall-clock time (weekends are EXTENDED), as Greenwick stores it. */
export function etSession(t: number): string {
  const p = partsET(t);
  if (p.wd === 0 || p.wd === 6) return "EXTENDED";
  const m = p.h * 60 + p.mi;
  if (m >= 240 && m < 570) return "PRE_MARKET";
  if (m >= 570 && m < 960) return "REGULAR";
  if (m >= 960 && m < 1200) return "AFTER_HOURS";
  return "EXTENDED";
}

export const etWeekday = (t: number): string => WEEKDAYS[partsET(t).wd] ?? "Sun";

const round = (x: number, dp: number): number => Number(x.toFixed(dp));

export interface StGenOptions {
  seed: string;
  count: number;
  /** First trading day, ET (y, m, d) */
  start: [number, number, number];
  days: number;
  winRate?: number;
  winRateAt?: (index: number, count: number) => number;
  breakevenRate?: number;
  annotate?: boolean;
  firstTicket?: number;
  /** Fraction of trades outside regular hours */
  extendedRate?: number;
}

const TAGS = ["gap-and-go", "vwap-reclaim", "orb", "earnings", "fade", "momentum"] as const;
const EMOTIONS = ["CALM", "CONFIDENT", "ANXIOUS", "FRUSTRATED", "REVENGE", "FOMO", "BORED"] as const;
const RULES = ["Waited for the open", "Size ≤ plan", "Stop placed", "Volume confirmed"] as const;

export function generateSt(opts: StGenOptions): StTrade[] {
  const rng = new Rng(opts.seed);
  const symbols = Object.keys(ST_SYMBOLS);
  const trades: StTrade[] = [];
  const usedClose = new Set<number>();
  let ticket = opts.firstTicket ?? 4_100_001;
  const [sy, sm, sd] = opts.start;
  const startNoon = et(sy, sm, sd, 12);

  for (let i = 0; i < opts.count; i++) {
    const symbol = rng.pick(symbols);
    const info = ST_SYMBOLS[symbol] ?? { price: 50, sector: "", industry: "" };
    const direction: Direction = rng.chance(0.75) ? "BUY" : "SELL";
    const shares = rng.pick([1, 5, 10, 25, 50, 100, 150, 200, 0.5]);

    let openTime: number | undefined;
    while (openTime === undefined) {
      const dayNoon = startNoon + rng.int(0, opts.days) * DAY;
      const p = partsET(dayNoon);
      if (p.wd === 0 || p.wd === 6) continue;
      const extended = rng.chance(opts.extendedRate ?? 0.12);
      const minuteOfDay = extended
        ? rng.pick([4 * 60 + 15, 7 * 60 + 40, 9 * 60 + 10, 16 * 60 + 5, 17 * 60 + 30, 19 * 60 + 45])
        : rng.int(9 * 60 + 30, 15 * 60 + 55);
      openTime = et(p.y, p.m, p.d, Math.floor(minuteOfDay / 60), minuteOfDay % 60, rng.int(0, 59));
    }
    const durationMin = rng.chance(0.1) ? rng.int(0, 4) : rng.chance(0.7) ? rng.int(5, 90) : rng.int(91, 380);
    let closeTime = openTime + durationMin * MIN;
    while (usedClose.has(closeTime)) closeTime += 1;
    usedClose.add(closeTime);

    const winP = opts.winRateAt ? opts.winRateAt(i, opts.count) : (opts.winRate ?? 0.52);
    const beRate = opts.breakevenRate ?? 0.03;
    const price = info.price * (1 + (rng.float() - 0.5) * 0.2);
    const slDist = round(price * (0.004 + rng.float() * 0.012), 2) || 0.01;
    const roll = rng.float();
    let r: number;
    if (roll < beRate) r = 0;
    else if (roll < beRate + winP) r = round(0.2 + rng.float() * 3, 2);
    else r = -round(rng.chance(0.65) ? 1 : 0.15 + rng.float() * 0.85, 2);

    const sign = direction === "BUY" ? 1 : -1;
    const move = round(r * slDist, 2);
    const openPrice = round(price, 2);
    const closePrice = round(openPrice + sign * move, 2);
    const commCents = rng.chance(0.4) ? 0 : rng.int(1, 300);
    // Greenwick stores P&L net of costs.
    const grossCents = Math.round((closePrice - openPrice) * sign * shares * 100) + (r === 0 ? 0 : rng.int(0, 9));
    const netCents = r === 0 ? 0 : grossCents - commCents;
    const risk = slDist * shares;

    const trade: StTrade = {
      ticket: String(ticket),
      symbol,
      direction,
      shares,
      openTime,
      closeTime,
      durationMin,
      openPrice: openPrice.toFixed(2),
      closePrice: closePrice.toFixed(2),
      sl: (openPrice - sign * slDist).toFixed(2),
      tp: (openPrice + sign * slDist * 2).toFixed(2),
      netProfit: money(netCents),
      maePoints: round(Math.max(0, -move) + rng.float() * slDist * 0.5, 2),
      mfePoints: round(Math.max(0, move) + rng.float() * slDist, 2),
      rMultiple: risk > 0 ? round(netCents / 100 / risk, 2) : 0,
      session: etSession(openTime),
      dayOfWeek: etWeekday(openTime),
      hour: partsET(openTime).h,
      rangeSize: round(price * 0.02 * rng.float(), 2),
      hitBreakeven: rng.chance(0.15),
      scaledIn: rng.chance(0.1),
      comment: "fictional",
      timeToMFEMin: rng.chance(0.2) ? 0 : Math.min(durationMin, rng.int(1, Math.max(1, durationMin))),
      slDistPoints: slDist,
      slippagePoints: rng.chance(0.4) ? 0 : round(rng.float() * 0.12, 2),
      sector: info.sector,
      industry: info.industry,
      volume: rng.int(50_000, 9_000_000),
      avgVolume: rng.int(500_000, 4_000_000),
      notes: "",
      tags: "",
      emotion: "",
      checklistData: "",
      commission: money(commCents),
      swap: "0",
      isSample: false,
    };
    if (opts.annotate) {
      if (rng.chance(0.7)) trade.tags = [...new Set([rng.pick(TAGS), rng.pick(TAGS)])].join(",");
      if (rng.chance(0.6)) trade.emotion = rng.pick(EMOTIONS);
      if (rng.chance(0.5)) {
        trade.checklistData = `{${RULES.map((x) => `${JSON.stringify(x)}:${rng.chance(0.7)}`).join(",")}}`;
      }
    }
    trades.push(trade);
    ticket += rng.int(1, 30);
  }
  trades.sort((a, b) => a.closeTime - b.closeTime);
  return trades;
}

type Key = (t: StTrade) => string;

export const ST_TIE_KEYS: readonly Key[] = [
  (t) => String(t.hour),
  (t) => t.session,
  (t) => t.dayOfWeek,
  (t) => t.symbol,
  (t) => t.sector,
  (t) => t.direction,
  (t) => t.tags,
  (t) => t.emotion,
];

export function breakStTies(trades: StTrade[], keys: readonly Key[]): void {
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    for (const key of keys) {
      const totals = new Map<string, number>();
      const last = new Map<string, StTrade>();
      for (const t of trades) {
        totals.set(key(t), (totals.get(key(t)) ?? 0) + cents(t.netProfit));
        last.set(key(t), t);
      }
      const seen = new Set<number>();
      for (const [k, total] of [...totals.entries()].sort()) {
        if (seen.has(total)) {
          const t = last.get(k);
          if (t && cents(t.netProfit) !== 0) {
            const c = cents(t.netProfit);
            t.netProfit = money(c + (c > 0 ? 1 : -1));
            changed = true;
          }
        } else seen.add(total);
      }
    }
    if (!changed) return;
  }
  throw new Error("could not break ties");
}

/** One broker transaction (a fill), for the FIFO formats. */
export interface Txn {
  symbol: string;
  side: "BUY" | "SELL";
  shares: number;
  price: string;
  /** UTC seconds of the fill (ET wall clock is derived for each format) */
  time: number;
  commission: string;
  fees: string;
  /** Free-form action text when a format needs a special one (option rows, etc.) */
  action?: string;
  description?: string;
}
