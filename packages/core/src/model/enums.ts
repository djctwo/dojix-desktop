// Enumerations shared with the Mac apps. Raw values are the strings the Mac stores.

export type TradeDirection = "BUY" | "SELL";
export const TRADE_DIRECTIONS: readonly TradeDirection[] = ["BUY", "SELL"];

// --- Dojix forex sessions (Dojix `Models/Trade.swift:79-134`) ------------------------------

export type TradingSession = "ASIAN" | "LONDON" | "NY_OVERLAP" | "NY" | "LATE";

/** `TradingSession.allCases` (declaration order; the order SessionRankingCard walks). */
export const TRADING_SESSIONS: readonly TradingSession[] = ["ASIAN", "LONDON", "NY_OVERLAP", "NY", "LATE"];

export interface TradingSessionInfo {
  displayName: string;
  /** Sessions whose trades count for this session's analysis (`relatedSessions`). */
  related: readonly TradingSession[];
  /** UTC hour the session window starts (`startHourUTC`). */
  startHourUTC: number;
  /** UTC hour the session window ends (`endHourUTC`; 24 = midnight). */
  endHourUTC: number;
}

export const TRADING_SESSION_INFO: Readonly<Record<TradingSession, TradingSessionInfo>> = {
  ASIAN: { displayName: "Asian", related: ["ASIAN"], startHourUTC: 0, endHourUTC: 9 },
  LONDON: { displayName: "London", related: ["LONDON", "NY_OVERLAP"], startHourUTC: 7, endHourUTC: 16 },
  NY_OVERLAP: { displayName: "NY Overlap", related: ["NY_OVERLAP"], startHourUTC: 12, endHourUTC: 16 },
  NY: { displayName: "New York", related: ["NY", "NY_OVERLAP"], startHourUTC: 12, endHourUTC: 21 },
  LATE: { displayName: "Late", related: ["LATE"], startHourUTC: 21, endHourUTC: 24 },
};

// --- Greenwick market sessions (Greenwick `Models/Trade.swift:83-133`) ---------------------

export type MarketSession = "PRE_MARKET" | "REGULAR" | "AFTER_HOURS" | "EXTENDED";

/** `MarketSession.allCases` (declaration order). */
export const MARKET_SESSIONS: readonly MarketSession[] = ["PRE_MARKET", "REGULAR", "AFTER_HOURS", "EXTENDED"];

export interface MarketSessionInfo {
  displayName: string;
  related: readonly MarketSession[];
  /** Exchange-time hour the session starts (`startHourET`, from `Market.default`). */
  startHourET: number;
  /** Exchange-time hour the session ends (`endHourET`). */
  endHourET: number;
}

export const MARKET_SESSION_INFO: Readonly<Record<MarketSession, MarketSessionInfo>> = {
  PRE_MARKET: { displayName: "Pre-Market", related: ["PRE_MARKET"], startHourET: 4, endHourET: 9 },
  REGULAR: { displayName: "Regular", related: ["REGULAR"], startHourET: 9, endHourET: 16 },
  AFTER_HOURS: { displayName: "After Hours", related: ["AFTER_HOURS"], startHourET: 16, endHourET: 20 },
  EXTENDED: {
    displayName: "Extended",
    related: ["EXTENDED", "PRE_MARKET", "AFTER_HOURS"],
    startHourET: 4,
    endHourET: 20,
  },
};

/**
 * Swift `Comparable` on these enums compares **raw values as strings** (both apps'
 * `extension TradingSession: Comparable { lhs.rawValue < rhs.rawValue }`), so "LATE" < "LONDON"
 * < "NY" < "NY_OVERLAP". Use this, not the declaration order, wherever the Mac sorts by session.
 */
export function compareRawValue(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Dojix-only fields --------------------------------------------------------------------

export type VolatilityRegime = "LOW" | "MED" | "HIGH";
export const VOLATILITY_REGIMES: readonly VolatilityRegime[] = ["LOW", "MED", "HIGH"];

export type BiasAlignment = "WITH" | "AGAINST" | "NEUTRAL";
export const BIAS_ALIGNMENTS: readonly BiasAlignment[] = ["WITH", "AGAINST", "NEUTRAL"];

// --- Both apps ------------------------------------------------------------------------------

export type TradeEmotion = "CALM" | "CONFIDENT" | "ANXIOUS" | "FRUSTRATED" | "REVENGE" | "FOMO" | "BORED";

/** `TradeEmotion.allCases` with display names (both apps, `Models/Trade.swift`). */
export const TRADE_EMOTIONS: Readonly<Record<TradeEmotion, string>> = {
  CALM: "Calm",
  CONFIDENT: "Confident",
  ANXIOUS: "Anxious",
  FRUSTRATED: "Frustrated",
  REVENGE: "Revenge",
  FOMO: "FOMO",
  BORED: "Bored",
};

export function isTradingSession(v: unknown): v is TradingSession {
  return typeof v === "string" && (TRADING_SESSIONS as readonly string[]).includes(v);
}

export function isMarketSession(v: unknown): v is MarketSession {
  return typeof v === "string" && (MARKET_SESSIONS as readonly string[]).includes(v);
}

export function isVolatilityRegime(v: unknown): v is VolatilityRegime {
  return typeof v === "string" && (VOLATILITY_REGIMES as readonly string[]).includes(v);
}

export function isBiasAlignment(v: unknown): v is BiasAlignment {
  return typeof v === "string" && (BIAS_ALIGNMENTS as readonly string[]).includes(v);
}

/** `Trade.tradeEmotion`: the stored raw value if it is a known emotion, else null. */
export function parseTradeEmotion(raw: string | null | undefined): TradeEmotion | null {
  if (!raw) return null;
  return Object.hasOwn(TRADE_EMOTIONS, raw) ? (raw as TradeEmotion) : null;
}
