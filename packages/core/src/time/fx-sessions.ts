// Dojix forex sessions and UTC helpers (Dojix `Extensions/Date+Forex.swift`).
//
// Two bucket sets exist (SPEC §3.1):
// - the **app** buckets, derived from real UTC for generic/OANDA imports and the live clock:
//   Asian 0–6, London 7–11, NY Overlap 12–15, NY 16–20, Late 21–23;
// - the **file** buckets written by the external analysis script into 32-column MT5 files
//   (Asian 0–7, London 8–11, NY_Overlap 12–16, NY 17–21, Late 22–23). The importer trusts the
//   file's own Session / Day / Hour columns verbatim; `fxFileSessionForHour` exists for
//   fixture generation and tests only.

import type { TradingSession } from "../model/enums";
import { TRADING_SESSION_INFO } from "../model/enums";
import { POSIX_WEEKDAY_NAMES, type WeekdayName } from "./zoned-calendar";

function utcDate(t: number): Date {
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) throw new RangeError(`instant out of range: ${t}`);
  return new Date(t);
}

/** `Date.utcHour` (Date+Forex.swift:12-14). */
export function utcHour(t: number): number {
  return utcDate(t).getUTCHours();
}

/** `Date.shortDayName` in UTC, English ("Mon"); what the Dojix importers store. */
export function utcShortDayName(t: number): WeekdayName {
  return POSIX_WEEKDAY_NAMES[utcDate(t).getUTCDay()] as WeekdayName;
}

/** App session for a UTC hour (Date+Forex.swift:17-30). Hours outside 0–23 fall to Late. */
export function fxSessionForHour(h: number): TradingSession {
  if (h >= 12 && h < 16) return "NY_OVERLAP";
  if (h >= 7 && h < 12) return "LONDON";
  if (h >= 0 && h < 7) return "ASIAN";
  if (h >= 16 && h < 21) return "NY";
  return "LATE";
}

/** `Date.tradingSession`: the primary session the trade is tagged with. */
export function fxSessionAt(t: number): TradingSession {
  return fxSessionForHour(utcHour(t));
}

/**
 * `Date.activeTradingSessions` (Date+Forex.swift:34-42): every session open at this UTC hour,
 * in the order Asian, London, NY, Late. Asian 0–9, London 7–16, NY 12–21, Late 21–24. NY
 * Overlap is never listed (it is only a tagging bucket).
 */
export function fxActiveSessions(t: number): TradingSession[] {
  const h = utcHour(t);
  const sessions: TradingSession[] = [];
  if (h >= 0 && h < 9) sessions.push("ASIAN");
  if (h >= 7 && h < 16) sessions.push("LONDON");
  if (h >= 12 && h < 21) sessions.push("NY");
  if (h >= 21) sessions.push("LATE");
  return sessions.length === 0 ? ["LATE"] : sessions;
}

/**
 * `Date.timeToNextSession` in seconds (Date+Forex.swift:70-82): to the next primary boundary
 * (7, 12, 16, 21, 24 UTC), counting whole hours minus the current minute. Seconds are ignored,
 * so at 06:59:59 it reports 60 s.
 */
export function fxTimeToNextSession(t: number): number {
  const d = utcDate(t);
  const h = d.getUTCHours();
  let next: number;
  if (h < 7) next = 7;
  else if (h < 12) next = 12;
  else if (h < 16) next = 16;
  else if (h < 21) next = 21;
  else next = 24;
  return (next - h) * 3600 - d.getUTCMinutes() * 60;
}

/**
 * The sidebar's "Nh left" (Dojix `Views/SidebarView.swift:308-320`): hours from now to the
 * *active-window* end of the current primary session, `(end − hour + 24) % 24`. Note the mix:
 * Asian is tagged until 07:00 but counts down to 09:00.
 */
export function fxSidebarHoursLeft(t: number): number {
  const session = fxSessionAt(t);
  const end = TRADING_SESSION_INFO[session].endHourUTC;
  return (end - utcHour(t) + 24) % 24;
}

/** Session label the 32-column analysis script writes for a broker-time hour (fixtures only). */
export function fxFileSessionForHour(h: number): TradingSession {
  if (h >= 0 && h <= 7) return "ASIAN";
  if (h >= 8 && h <= 11) return "LONDON";
  if (h >= 12 && h <= 16) return "NY_OVERLAP";
  if (h >= 17 && h <= 21) return "NY";
  return "LATE";
}
