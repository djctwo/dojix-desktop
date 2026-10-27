// Time helpers. Everything is integer seconds since the Unix epoch (UTC).
// US Eastern time is converted with the explicit US DST rule (2nd Sunday of March 02:00 →
// 1st Sunday of November 02:00), so the output never depends on the machine's tz database.

export const MIN = 60;
export const HOUR = 3600;
export const DAY = 86400;

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function utc(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  return Date.UTC(y, m - 1, d, h, mi, s) / 1000;
}

export interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0 = Sunday */
  wd: number;
}

export function partsUTC(t: number): Parts {
  const dt = new Date(t * 1000);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
    wd: dt.getUTCDay(),
  };
}

const p2 = (n: number): string => String(n).padStart(2, "0");
const p4 = (n: number): string => String(n).padStart(4, "0");

/** n-th weekday (0 = Sun) of a month, day of month. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** True when the US Eastern wall-clock time is in daylight saving time. */
function etIsDst(y: number, m: number, d: number, h: number): boolean {
  const start = nthWeekday(y, 3, 0, 2);
  const end = nthWeekday(y, 11, 0, 1);
  const key = m * 10000 + d * 100 + h;
  return key >= 3 * 10000 + start * 100 + 2 && key < 11 * 10000 + end * 100 + 2;
}

/** UTC seconds for a US Eastern wall-clock time. */
export function et(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const offset = etIsDst(y, m, d, h) ? 4 : 5;
  return utc(y, m, d, h + offset, mi, s);
}

/** US Eastern wall-clock parts of a UTC instant. */
export function partsET(t: number): Parts {
  // Try EDT first; if that wall time is not in DST, it is EST.
  const edt = partsUTC(t - 4 * HOUR);
  if (etIsDst(edt.y, edt.m, edt.d, edt.h)) return edt;
  return partsUTC(t - 5 * HOUR);
}

export function fmt(p: Parts, pattern: string): string {
  // Tokens: yyyy yy MM M dd d HH mm ss
  return pattern.replace(/yyyy|yy|MM|M|dd|d|HH|mm|ss/g, (tok) => {
    switch (tok) {
      case "yyyy":
        return p4(p.y);
      case "yy":
        return p2(p.y % 100);
      case "MM":
        return p2(p.m);
      case "M":
        return String(p.m);
      case "dd":
        return p2(p.d);
      case "d":
        return String(p.d);
      case "HH":
        return p2(p.h);
      case "mm":
        return p2(p.mi);
      case "ss":
        return p2(p.s);
      default:
        return tok;
    }
  });
}

/** ISO-8601 UTC with milliseconds, e.g. 2026-01-05T10:00:00.000Z */
export function iso(t: number): string {
  return new Date(t * 1000).toISOString();
}

export function weekdayName(t: number): string {
  return WEEKDAYS[partsUTC(t).wd] ?? "Sun";
}

/** UTC offset of US Eastern time at a UTC instant, e.g. "-0400" or "-0500". */
export function etOffset(t: number): string {
  const p = partsET(t);
  const hours = (utc(p.y, p.m, p.d, p.h, p.mi, p.s) - t) / HOUR;
  return `-0${-hours}00`;
}
