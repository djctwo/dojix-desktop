// NYSE full-day holidays and the desktop's Greenwick session clock.
//
// DESKTOP ADDITION (SPEC §2.1, PARITY B2 "Greenwick session countdown"). The Mac has no holiday
// calendar anywhere; its countdown (`etTimeToNextSession`) ignores weekends and holidays.
// The desktop's sidebar clock skips weekends and NYSE full-day holidays and shows
// "Closed (holiday)". Display only: no analytics use this file.
//
// Rules (NYSE Rule 7.2): New Year's Day (a Saturday New Year is not moved to Friday), Martin
// Luther King Jr. Day (3rd Monday of January), Washington's Birthday (3rd Monday of February),
// Good Friday, Memorial Day (last Monday of May), Juneteenth (from 2022), Independence Day,
// Labor Day (1st Monday of September), Thanksgiving (4th Thursday of November), Christmas.
// A Saturday holiday is observed the Friday before, a Sunday holiday the Monday after.
// One-off closures (national days of mourning, weather) and early closes are not modelled.

import type { MarketSession } from "../model/enums";
import { sessionAtMinute, TRADING_CALENDAR, US_MARKET } from "./us-market";

export interface MarketHoliday {
  /** "YYYY-MM-DD" (exchange date). */
  date: string;
  name: string;
}

function key(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 0 = Sunday … 6 = Saturday for a Gregorian date. */
function dow(y: number, m: number, d: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCDay();
}

function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = dow(y, m, 1);
  return 1 + ((weekday - first + 7) % 7) + 7 * (n - 1);
}

function lastWeekday(y: number, m: number, weekday: number): number {
  const lastDay = daysIn(y, m);
  const lastDow = dow(y, m, lastDay);
  return lastDay - ((lastDow - weekday + 7) % 7);
}

function daysIn(y: number, m: number): number {
  const d = new Date(0);
  d.setUTCFullYear(y, m, 0);
  return d.getUTCDate();
}

/** Gregorian Easter Sunday (anonymous Gregorian algorithm). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** A fixed-date holiday moved off the weekend; null when NYSE does not observe it that year. */
function observed(y: number, m: number, d: number, saturdayMovesToFriday: boolean): string | null {
  const w = dow(y, m, d);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  if (w === 6) {
    if (!saturdayMovesToFriday) return null;
    date.setUTCDate(date.getUTCDate() - 1);
  } else if (w === 0) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return key(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** NYSE full-day holidays observed in `year`, in date order. */
export function nyseHolidays(year: number): MarketHoliday[] {
  const list: MarketHoliday[] = [];
  const add = (date: string | null, name: string) => {
    if (date !== null) list.push({ date, name });
  };
  add(observed(year, 1, 1, false), "New Year's Day");
  add(key(year, 1, nthWeekday(year, 1, 1, 3)), "Martin Luther King Jr. Day");
  add(key(year, 2, nthWeekday(year, 2, 1, 3)), "Washington's Birthday");
  const easter = easterSunday(year);
  const goodFriday = new Date(0);
  goodFriday.setUTCFullYear(year, easter.month - 1, easter.day - 2);
  add(key(year, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()), "Good Friday");
  add(key(year, 5, lastWeekday(year, 5, 1)), "Memorial Day");
  if (year >= 2022) add(observed(year, 6, 19, true), "Juneteenth");
  add(observed(year, 7, 4, true), "Independence Day");
  add(key(year, 9, nthWeekday(year, 9, 1, 1)), "Labor Day");
  add(key(year, 11, nthWeekday(year, 11, 4, 4)), "Thanksgiving Day");
  add(observed(year, 12, 25, true), "Christmas Day");
  // A Sunday New Year of the *next* year is observed on Monday 2 January of that year, so
  // nothing spills back into `year`.
  return list.sort((a, b) => (a.date < b.date ? -1 : 1));
}

const holidayCache = new Map<number, Map<string, string>>();

/** The NYSE holiday on an exchange date "YYYY-MM-DD", or null. */
export function nyseHolidayOn(dayKey: string): string | null {
  const year = Number(dayKey.slice(0, 4));
  let map = holidayCache.get(year);
  if (!map) {
    map = new Map(nyseHolidays(year).map((h) => [h.date, h.name]));
    holidayCache.set(year, map);
  }
  return map.get(dayKey) ?? null;
}

/** What the desktop's Greenwick sidebar clock shows. */
export interface UsSessionClock {
  /** The session now, or null when the market is closed for the whole day. */
  session: MarketSession | null;
  closed: "weekend" | "holiday" | null;
  /** Holiday name when `closed === "holiday"`. */
  holiday: string | null;
  /** Instant of the next session change (epoch ms). */
  nextChange: number;
  /** Seconds until `nextChange` (real elapsed time, so DST nights count correctly). */
  secondsLeft: number;
}

function isTradingDate(y: number, m: number, d: number): boolean {
  const w = dow(y, m, d);
  return w !== 0 && w !== 6 && nyseHolidayOn(key(y, m, d)) === null;
}

/** 04:00 ET on the first trading date strictly after (y, m, d). */
function nextTradingOpen(y: number, m: number, d: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  for (let i = 0; i < 30; i++) {
    date.setUTCDate(date.getUTCDate() + 1);
    const yy = date.getUTCFullYear();
    const mm = date.getUTCMonth() + 1;
    const dd = date.getUTCDate();
    if (isTradingDate(yy, mm, dd)) {
      return TRADING_CALENDAR.instantFromWall(yy, mm, dd, 0, US_MARKET.preMarketOpen);
    }
  }
  /* c8 ignore next */
  throw new RangeError("no trading day within 30 days");
}

/** The desktop Greenwick session clock at `now` (skips weekends and NYSE full-day holidays). */
export function usSessionClock(now: number): UsSessionClock {
  const f = TRADING_CALENDAR.fields(now);
  const dk = key(f.year, f.month, f.day);
  const weekend = f.weekday === 1 || f.weekday === 7;
  const holiday = weekend ? null : nyseHolidayOn(dk);
  const at = (minute: number) => TRADING_CALENDAR.instantFromWall(f.year, f.month, f.day, 0, minute);
  let session: MarketSession | null;
  let nextChange: number;
  if (weekend || holiday !== null) {
    session = null;
    nextChange = nextTradingOpen(f.year, f.month, f.day);
  } else {
    const minute = f.hour * 60 + f.minute;
    session = sessionAtMinute(minute);
    const boundary = [US_MARKET.preMarketOpen, US_MARKET.regularOpen, US_MARKET.regularClose, US_MARKET.afterHoursClose].find(
      (b) => minute < b,
    );
    nextChange = boundary === undefined ? nextTradingOpen(f.year, f.month, f.day) : at(boundary);
  }
  return {
    session,
    closed: weekend ? "weekend" : holiday !== null ? "holiday" : null,
    holiday,
    nextChange,
    secondsLeft: Math.max(0, Math.floor((nextChange - now) / 1000)),
  };
}
