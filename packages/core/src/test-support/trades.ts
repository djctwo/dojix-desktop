// Fictional trades for tests. Every value here is made up.

import type { DojixTrade, GreenwickTrade } from "../model/trade";

let nextTicket = 1;

/** A Dojix trade with the defaults of the Mac's `MetricsCalculatorTests.makeTrade`. */
export function fxTrade(overrides: Partial<DojixTrade> = {}): DojixTrade {
  const closeTime = overrides.closeTime ?? Date.UTC(2026, 0, 15, 10, 0);
  const durationMin = overrides.durationMin ?? 60;
  return {
    brand: "dojix",
    id: null,
    ticket: String(nextTicket++),
    symbol: "GBPUSD",
    direction: "BUY",
    lots: 0.1,
    openTime: closeTime - durationMin * 60_000,
    closeTime,
    durationMin,
    openPrice: "1.25",
    closePrice: "1.26",
    sl: "1.24",
    tp: "1.27",
    netProfit: "0",
    commission: "0",
    swap: "0",
    maePips: 5,
    mfePips: 10,
    rMultiple: 1,
    session: "LONDON",
    dayOfWeek: "Mon",
    hour: 10,
    rangeSize: 40,
    sweepDepth: 10,
    usedFVG: false,
    volRegime: "MED",
    hitBreakeven: false,
    scaledIn: false,
    magic: 0,
    comment: "",
    timeToMFEMin: 30,
    slDistPips: 20,
    slippagePips: 0.5,
    postClose15m: 5,
    postClose30m: 10,
    biasAtEntry: "WITH",
    notes: "",
    tags: [],
    emotion: "",
    checklist: {},
    importedAt: Date.UTC(2026, 0, 16),
    isSample: false,
    ...overrides,
  };
}

/** A Greenwick trade (fictional ticker "FICT"). */
export function stTrade(overrides: Partial<GreenwickTrade> = {}): GreenwickTrade {
  const closeTime = overrides.closeTime ?? Date.UTC(2026, 9, 23, 15, 0);
  const durationMin = overrides.durationMin ?? 30;
  return {
    brand: "greenwick",
    id: null,
    ticket: String(nextTicket++),
    symbol: "FICT",
    direction: "BUY",
    shares: 100,
    openTime: closeTime - durationMin * 60_000,
    closeTime,
    durationMin,
    openPrice: "100",
    closePrice: "101",
    sl: "0",
    tp: "0",
    netProfit: "0",
    commission: "0",
    swap: "0",
    maePoints: 0,
    mfePoints: 0,
    rMultiple: 0,
    session: "REGULAR",
    dayOfWeek: "Fri",
    hour: 10,
    rangeSize: 0,
    hitBreakeven: false,
    scaledIn: false,
    comment: "",
    timeToMFEMin: 0,
    slDistPoints: 0,
    slippagePoints: 0,
    sector: "",
    industry: "",
    volume: 0,
    avgVolume: 0,
    notes: "",
    tags: [],
    emotion: "",
    checklist: {},
    importedAt: Date.UTC(2026, 9, 24),
    isSample: false,
    ...overrides,
  };
}

/** Builds trades with the given P&Ls, closing 100 s apart in this order (ascending times). */
export function fxSeries(profits: readonly string[], start = Date.UTC(2026, 0, 15, 10, 0)): DojixTrade[] {
  return profits.map((p, i) => fxTrade({ netProfit: p, closeTime: start + i * 100_000 }));
}

/** A wall-clock moment in New York (the Greenwick tests' `et(...)` helper). */
export function etWall(year: number, month: number, day: number, hour: number, minute: number): number {
  // Brute-force through Intl so the helper does not depend on the code under test.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  for (const offsetHours of [4, 5]) {
    const t = guess + offsetHours * 3_600_000;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    if (get("year") === year && get("month") === month && get("day") === day && get("hour") === hour && get("minute") === minute) {
      return t;
    }
  }
  throw new Error(`no such New York time ${year}-${month}-${day} ${hour}:${minute}`);
}
