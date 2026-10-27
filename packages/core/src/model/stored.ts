// The journal row (SPEC §4.1 `trades`, camelCase as it crosses IPC) and its mapping to the
// engine's Trade (SPEC §4.2). Storage validation itself lives in packages/importers (it is
// shared with restore); this mapping assumes a row that passed it and throws on anything else.

import type { BrandId } from "../brand";
import { parseGrdbDate } from "../time/grdb-time";
import {
  isBiasAlignment,
  isMarketSession,
  isTradingSession,
  isVolatilityRegime,
  type TradeDirection,
} from "./enums";
import type { DecimalText, DojixTrade, GreenwickTrade, Trade, TradeOf } from "./trade";

/** One `trades` row. Nullable columns are `null`; times are GRDB UTC text. */
export interface StoredTrade {
  id: number;
  ticket: string | number;
  source: string;
  externalId: string | null;
  isSample: boolean | 0 | 1;
  accountId: number;
  importBatchId: number | null;
  symbol: string;
  direction: TradeDirection;
  quantity: number;
  openTime: string;
  closeTime: string;
  timeBasis: "utc" | "broker";
  durationMin: number;
  openPrice: DecimalText;
  closePrice: DecimalText;
  sl: DecimalText;
  tp: DecimalText;
  netProfit: DecimalText;
  commission: DecimalText;
  swap: DecimalText;
  mae: number | null;
  mfe: number | null;
  rMultiple: number | null;
  session: string;
  dayOfWeek: string;
  hour: number;
  timeToMfeMin: number | null;
  slDist: number | null;
  slippage: number | null;
  rangeSize: number | null;
  hitBreakeven: boolean | 0 | 1 | null;
  scaledIn: boolean | 0 | 1 | null;
  // forex only
  sweepDepth: number | null;
  usedFvg: boolean | 0 | 1 | null;
  volRegime: string | null;
  magic: number | null;
  postClose15m: number | null;
  postClose30m: number | null;
  biasAtEntry: string | null;
  // stocks only
  sector: string | null;
  industry: string | null;
  volume: number | null;
  avgVolume: number | null;
  // annotations
  comment: string;
  notes: string;
  /** JSON array text. */
  tags: string;
  emotion: string | null;
  /** JSON object text. */
  checklist: string;
  importedAt: string;
  updatedAt: string;
}

function time(row: StoredTrade, field: "openTime" | "closeTime" | "importedAt"): number {
  const t = parseGrdbDate(row[field]);
  if (t === null) throw new TypeError(`trade ${row.id}: ${field} is not GRDB date text`);
  return t;
}

function bool(v: boolean | 0 | 1 | null): boolean {
  return v === true || v === 1;
}

function parseTags(row: StoredTrade): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.tags);
  } catch {
    throw new TypeError(`trade ${row.id}: tags is not JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
    throw new TypeError(`trade ${row.id}: tags is not a string array`);
  }
  return parsed;
}

function parseChecklist(row: StoredTrade): Record<string, boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.checklist);
  } catch {
    throw new TypeError(`trade ${row.id}: checklist is not JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`trade ${row.id}: checklist is not an object`);
  }
  const out: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "boolean") throw new TypeError(`trade ${row.id}: checklist value for ${k} is not a boolean`);
    out[k] = v;
  }
  return out;
}

/** Maps a validated journal row to the engine trade of `brand`. Unknown numeric columns read as 0 (the Mac storage) except MAE/MFE (D-18). */
export function toEngineTrade<B extends BrandId>(row: StoredTrade, brand: B): TradeOf<B> {
  const common = {
    id: row.id,
    ticket: String(row.ticket),
    symbol: row.symbol,
    direction: row.direction,
    openTime: time(row, "openTime"),
    closeTime: time(row, "closeTime"),
    durationMin: row.durationMin,
    openPrice: row.openPrice,
    closePrice: row.closePrice,
    sl: row.sl,
    tp: row.tp,
    netProfit: row.netProfit,
    commission: row.commission,
    swap: row.swap,
    rMultiple: row.rMultiple ?? 0,
    dayOfWeek: row.dayOfWeek,
    hour: row.hour,
    rangeSize: row.rangeSize ?? 0,
    hitBreakeven: bool(row.hitBreakeven),
    scaledIn: bool(row.scaledIn),
    comment: row.comment,
    timeToMFEMin: row.timeToMfeMin ?? 0,
    notes: row.notes,
    tags: parseTags(row),
    emotion: row.emotion ?? "",
    checklist: parseChecklist(row),
    importedAt: time(row, "importedAt"),
    isSample: bool(row.isSample),
  };
  if (row.direction !== "BUY" && row.direction !== "SELL") {
    throw new TypeError(`trade ${row.id}: direction ${String(row.direction)}`);
  }
  let trade: Trade;
  if (brand === "dojix") {
    if (!isTradingSession(row.session)) throw new TypeError(`trade ${row.id}: session ${row.session}`);
    const vol = row.volRegime ?? "MED";
    const bias = row.biasAtEntry ?? "NEUTRAL";
    if (!isVolatilityRegime(vol)) throw new TypeError(`trade ${row.id}: volRegime ${vol}`);
    if (!isBiasAlignment(bias)) throw new TypeError(`trade ${row.id}: biasAtEntry ${bias}`);
    const t: DojixTrade = {
      ...common,
      brand: "dojix",
      lots: row.quantity,
      maePips: row.mae,
      mfePips: row.mfe,
      session: row.session,
      sweepDepth: row.sweepDepth ?? 0,
      usedFVG: bool(row.usedFvg),
      volRegime: vol,
      magic: row.magic ?? 0,
      slDistPips: row.slDist ?? 0,
      slippagePips: row.slippage ?? 0,
      postClose15m: row.postClose15m ?? 0,
      postClose30m: row.postClose30m ?? 0,
      biasAtEntry: bias,
    };
    trade = t;
  } else {
    if (!isMarketSession(row.session)) throw new TypeError(`trade ${row.id}: session ${row.session}`);
    const t: GreenwickTrade = {
      ...common,
      brand: "greenwick",
      shares: row.quantity,
      maePoints: row.mae,
      mfePoints: row.mfe,
      session: row.session,
      slDistPoints: row.slDist ?? 0,
      slippagePoints: row.slippage ?? 0,
      sector: row.sector ?? "",
      industry: row.industry ?? "",
      volume: row.volume ?? 0,
      avgVolume: row.avgVolume ?? 0,
    };
    trade = t;
  }
  return trade as TradeOf<B>;
}
