// A Gregorian calendar in one IANA time zone, with Foundation's (ICU's) week rules.
//
// This is the engine's `Calendar`:
// - Dojix buckets days, weeks and months with `Calendar.current` (the computer's zone and the
//   locale's first weekday / minimum days in the first week). The desktop passes the user's
//   display zone and week settings (SPEC §3.1, §3.2).
// - Greenwick uses `TradingCalendar.calendar`: America/New_York, first weekday Monday (2),
//   minimumDaysInFirstWeek 4 (`Services/Analytics/TradingCalendar.swift:72-79`).
//
// Instants are epoch milliseconds (UTC). Wall-clock fields come from Intl (the IANA tz database
// that ships with the JS engine), so daylight-saving rules follow each zone's own history.
//
// Foundation details reproduced here:
// - weekday numbering 1 = Sunday … 7 = Saturday;
// - weekOfYear / yearForWeekOfYear / weekOfMonth use ICU's rules (a week belongs to the year
//   or month that holds at least `minimumDaysInFirstWeek` of its days; days before the first
//   such week of a month are "week 0");
// - wall times that do not exist (spring-forward gaps) are read with the offset in force
//   before the gap (so 02:30 on a US spring-forward day is 03:30 daylight time), and repeated
//   wall times (fall-back) resolve to the first occurrence;
// - `startOfDay` is the first instant whose wall date is that day (01:00 in zones whose
//   daylight saving starts at midnight);
// - adding days or months keeps the wall-clock time; adding months clamps the day of month
//   (31 March − 1 month = 28/29 February).

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** The range Date (and so Intl) accepts. */
const MAX_INSTANT = 8.64e15;

/** Week rules of a calendar, as in SPEC §3.2 `calendar`. */
export interface CalendarSpec {
  /** IANA zone, e.g. "UTC", "America/New_York", "Europe/Berlin". */
  tz: string;
  /** Foundation `firstWeekday`: 1 = Sunday … 7 = Saturday. */
  weekStart: number;
  /** Foundation `minimumDaysInFirstWeek`: 1 … 7. */
  minDaysInFirstWeek: number;
}

/** Wall-clock fields of an instant in the calendar's zone. */
export interface WallFields {
  year: number;
  /** 1 … 12 */
  month: number;
  /** 1 … 31 */
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 1 = Sunday … 7 = Saturday */
  weekday: number;
  /** 1 … 366 */
  dayOfYear: number;
}

/** POSIX short weekday names indexed by weekday − 1 (`TradingCalendar.weekdayNames`). */
export const POSIX_WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export type WeekdayName = (typeof POSIX_WEEKDAY_NAMES)[number];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a Gregorian year. */
export function daysInYear(year: number): number {
  return isLeap(year) ? 366 : 365;
}

/** Days in a Gregorian month (month 1 … 12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Throws unless `t` is an instant the calendar can represent. */
function checkInstant(t: number): void {
  if (!Number.isFinite(t) || Math.abs(t) > MAX_INSTANT) {
    throw new RangeError(`instant out of range: ${t}`);
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

export class ZonedCalendar {
  readonly tz: string;
  readonly weekStart: number;
  readonly minDaysInFirstWeek: number;
  private readonly isUtc: boolean;
  private readonly offsetCache = new Map<number, number>();

  constructor(spec: CalendarSpec) {
    if (!Number.isInteger(spec.weekStart) || spec.weekStart < 1 || spec.weekStart > 7) {
      throw new RangeError(`weekStart must be 1…7, got ${spec.weekStart}`);
    }
    if (!Number.isInteger(spec.minDaysInFirstWeek) || spec.minDaysInFirstWeek < 1 || spec.minDaysInFirstWeek > 7) {
      throw new RangeError(`minDaysInFirstWeek must be 1…7, got ${spec.minDaysInFirstWeek}`);
    }
    if (!isValidTimeZone(spec.tz)) throw new RangeError(`unknown time zone ${spec.tz}`);
    this.tz = spec.tz;
    this.weekStart = spec.weekStart;
    this.minDaysInFirstWeek = spec.minDaysInFirstWeek;
    this.isUtc = spec.tz === "UTC" || spec.tz === "Etc/UTC" || spec.tz === "GMT" || spec.tz === "Etc/GMT";
  }

  get spec(): CalendarSpec {
    return { tz: this.tz, weekStart: this.weekStart, minDaysInFirstWeek: this.minDaysInFirstWeek };
  }

  // --- offsets ------------------------------------------------------------------------

  private rawOffset(t: number): number {
    const parts = formatterFor(this.tz).formatToParts(new Date(t));
    let year = 0;
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    let second = 0;
    let bc = false;
    for (const p of parts) {
      switch (p.type) {
        case "year":
          year = Number(p.value);
          break;
        case "month":
          month = Number(p.value);
          break;
        case "day":
          day = Number(p.value);
          break;
        case "hour":
          hour = Number(p.value);
          break;
        case "minute":
          minute = Number(p.value);
          break;
        case "second":
          second = Number(p.value);
          break;
        case "era":
          bc = p.value.startsWith("B");
          break;
      }
    }
    const fullYear = bc ? 1 - year : year;
    const d = new Date(0);
    d.setUTCFullYear(fullYear, month - 1, day);
    d.setUTCHours(hour, minute, second, 0);
    const wallAsUtc = d.getTime();
    const tSeconds = Math.floor(t / 1000) * 1000;
    return wallAsUtc - tSeconds;
  }

  /** Offset of the zone from UTC at instant `t`, in ms (wall = t + offset). */
  offsetAt(t: number): number {
    checkInstant(t);
    if (this.isUtc) return 0;
    const hourKey = Math.floor(t / MS_PER_HOUR);
    const cached = this.offsetCache.get(hourKey);
    if (cached !== undefined) return cached;
    const start = hourKey * MS_PER_HOUR;
    const a = this.rawOffset(start);
    const b = this.rawOffset(start + MS_PER_HOUR - 1);
    if (a === b) {
      if (this.offsetCache.size > 200_000) this.offsetCache.clear();
      this.offsetCache.set(hourKey, a);
      return a;
    }
    return this.rawOffset(t);
  }

  // --- instant → fields ----------------------------------------------------------------

  /** Wall-clock fields of `t` in this calendar's zone. */
  fields(t: number): WallFields {
    const w = new Date(t + this.offsetAt(t));
    const year = w.getUTCFullYear();
    const month = w.getUTCMonth() + 1;
    const day = w.getUTCDate();
    const startOfYear = new Date(0);
    startOfYear.setUTCFullYear(year, 0, 1);
    startOfYear.setUTCHours(0, 0, 0, 0);
    const dayStart = new Date(0);
    dayStart.setUTCFullYear(year, month - 1, day);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayOfYear = Math.round((dayStart.getTime() - startOfYear.getTime()) / MS_PER_DAY) + 1;
    return {
      year,
      month,
      day,
      hour: w.getUTCHours(),
      minute: w.getUTCMinutes(),
      second: w.getUTCSeconds(),
      millisecond: w.getUTCMilliseconds(),
      weekday: w.getUTCDay() + 1,
      dayOfYear,
    };
  }

  /** `component(.weekday)`: 1 = Sunday … 7 = Saturday. */
  weekday(t: number): number {
    return this.fields(t).weekday;
  }

  /** POSIX short weekday name ("Mon"), independent of the user's language. */
  weekdayName(t: number): WeekdayName {
    return POSIX_WEEKDAY_NAMES[this.weekday(t) - 1] as WeekdayName;
  }

  /** Saturday or Sunday in this zone. */
  isWeekend(t: number): boolean {
    const d = this.weekday(t);
    return d === 1 || d === 7;
  }

  hour(t: number): number {
    return this.fields(t).hour;
  }

  minute(t: number): number {
    return this.fields(t).minute;
  }

  /** Minutes after local midnight (wall clock: hour × 60 + minute). */
  minuteOfDay(t: number): number {
    const f = this.fields(t);
    return f.hour * 60 + f.minute;
  }

  /** "2026-10-23": the wall date, zero-padded (`String(format: "%04d-%02d-%02d")`). */
  dayKey(t: number): string {
    const f = this.fields(t);
    return `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)}`;
  }

  /** "2026-07": the wall year and month. */
  monthKey(t: number): string {
    const f = this.fields(t);
    return `${pad(f.year, 4)}-${pad(f.month, 2)}`;
  }

  // --- week numbering (ICU) -------------------------------------------------------------

  /** ICU `Calendar::weekNumber(desiredDay, dayOfPeriod, dayOfWeek)`. */
  private weekNumber(desiredDay: number, dayOfPeriod: number, dayOfWeek: number): number {
    let periodStartDayOfWeek = (dayOfWeek - this.weekStart - dayOfPeriod + 1) % 7;
    if (periodStartDayOfWeek < 0) periodStartDayOfWeek += 7;
    let weekNo = Math.trunc((desiredDay + periodStartDayOfWeek - 1) / 7);
    if (7 - periodStartDayOfWeek >= this.minDaysInFirstWeek) weekNo += 1;
    return weekNo;
  }

  /** `dateComponents([.weekOfMonth])`: 0 for days before the month's first full-enough week. */
  weekOfMonth(t: number): number {
    const f = this.fields(t);
    return this.weekNumber(f.day, f.day, f.weekday);
  }

  /** `dateComponents([.yearForWeekOfYear, .weekOfYear])` (ICU `computeWeekFields`). */
  weekOfYear(t: number): { yearForWeekOfYear: number; weekOfYear: number } {
    const f = this.fields(t);
    const relDow = (f.weekday + 7 - this.weekStart) % 7;
    const relDowJan1 = (((f.weekday - f.dayOfYear + 7001 - this.weekStart) % 7) + 7) % 7;
    let woy = Math.trunc((f.dayOfYear - 1 + relDowJan1) / 7);
    if (7 - relDowJan1 >= this.minDaysInFirstWeek) woy += 1;
    let ywoy = f.year;
    if (woy === 0) {
      const prevDoy = f.dayOfYear + daysInYear(f.year - 1);
      woy = this.weekNumber(prevDoy, prevDoy, f.weekday);
      ywoy -= 1;
    } else {
      const lastDoy = daysInYear(f.year);
      if (f.dayOfYear >= lastDoy - 5) {
        let lastRelDow = (relDow + lastDoy - f.dayOfYear) % 7;
        if (lastRelDow < 0) lastRelDow += 7;
        if (6 - lastRelDow >= this.minDaysInFirstWeek && f.dayOfYear + 7 - relDow > lastDoy) {
          woy = 1;
          ywoy += 1;
        }
      }
    }
    return { yearForWeekOfYear: ywoy, weekOfYear: woy };
  }

  // --- fields → instant ----------------------------------------------------------------

  /**
   * `date(from: DateComponents(year:month:day:hour:minute:second:))`. Out-of-range fields
   * roll over (month 13 = January next year, day 0 = last day of the previous month), as
   * Foundation's lenient calendar does. See the file header for gap and overlap rules.
   */
  instantFromWall(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): number {
    const d = new Date(0);
    d.setUTCFullYear(year, month - 1, day);
    d.setUTCHours(hour, minute, second, millisecond);
    const local = d.getTime();
    checkInstant(local);
    if (this.isUtc) return local;
    const before = this.offsetAt(clampInstant(local - MS_PER_DAY));
    const after = this.offsetAt(clampInstant(local + MS_PER_DAY));
    const tBefore = local - before;
    const tAfter = local - after;
    const okBefore = this.offsetAt(clampInstant(tBefore)) === before;
    const okAfter = this.offsetAt(clampInstant(tAfter)) === after;
    if (okBefore && okAfter) return Math.min(tBefore, tAfter); // repeated wall time: first
    if (okBefore) return tBefore;
    if (okAfter) return tAfter;
    // Skipped wall time (or a zone with several changes in two days): use the earlier offset.
    const mid = this.offsetAt(clampInstant(local - before));
    const tMid = local - mid;
    return this.offsetAt(clampInstant(tMid)) === mid ? tMid : tBefore;
  }

  /** `startOfDay(for:)`: the first instant of `t`'s wall date. */
  startOfDay(t: number): number {
    const f = this.fields(t);
    return this.instantFromWall(f.year, f.month, f.day);
  }

  /** Whether two instants share a wall date (`isDate(_:inSameDayAs:)`). */
  isSameDay(a: number, b: number): boolean {
    const fa = this.fields(a);
    const fb = this.fields(b);
    return fa.year === fb.year && fa.month === fb.month && fa.day === fb.day;
  }

  /**
   * Start of the week containing `t` (`dateInterval(of: .weekOfYear, for:)?.start`, and
   * `date(from: dateComponents([.yearForWeekOfYear, .weekOfYear], from:))`).
   */
  startOfWeek(t: number): number {
    const f = this.fields(t);
    const back = (f.weekday - this.weekStart + 7) % 7;
    return this.instantFromWall(f.year, f.month, f.day - back);
  }

  /** `date(from: DateComponents(yearForWeekOfYear:, weekOfYear:))`: 00:00 on the week's first day. */
  startOfWeekOfYear(yearForWeekOfYear: number, weekOfYear: number): number {
    const jan1 = new Date(0);
    jan1.setUTCFullYear(yearForWeekOfYear, 0, 1);
    const jan1Weekday = jan1.getUTCDay() + 1;
    const relDowJan1 = (jan1Weekday - this.weekStart + 7) % 7;
    // Day of January (1-based, may be ≤ 0) on which the week holding 1 January starts.
    let week1StartDay = 1 - relDowJan1;
    if (7 - relDowJan1 < this.minDaysInFirstWeek) week1StartDay += 7;
    return this.instantFromWall(yearForWeekOfYear, 1, week1StartDay + 7 * (weekOfYear - 1));
  }

  /** The 1st of `t`'s month at 00:00 (`dateInterval(of: .month, for:)?.start`). */
  startOfMonth(t: number): number {
    const f = this.fields(t);
    return this.instantFromWall(f.year, f.month, 1);
  }

  /** `range(of: .day, in: .month, for:)?.count`. */
  daysInMonthOf(t: number): number {
    const f = this.fields(t);
    return daysInMonth(f.year, f.month);
  }

  /** `date(fromDayKey:)` for "YYYY-MM-DD" (TradingCalendar.swift:101-105): null unless 3 integers. */
  dateFromDayKey(key: string): number | null {
    const parts = key
      .split("-")
      .filter((p) => p !== "")
      .map(parseSwiftInt)
      .filter((v): v is number => v !== null);
    if (parts.length !== 3) return null;
    const [y, m, d] = parts as [number, number, number];
    try {
      return this.instantFromWall(y, m, d);
    } catch {
      return null;
    }
  }

  // --- arithmetic ------------------------------------------------------------------------

  /** `date(byAdding: .day, value: n, to: t)`: same wall-clock time `n` days later. */
  addDays(t: number, n: number): number {
    const f = this.fields(t);
    return this.instantFromWall(f.year, f.month, f.day + n, f.hour, f.minute, f.second, f.millisecond);
  }

  /** `date(byAdding: .month, value: n, to: t)`: the day of month is clamped to the new month. */
  addMonths(t: number, n: number): number {
    const f = this.fields(t);
    const total = f.year * 12 + (f.month - 1) + n;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    const day = Math.min(f.day, daysInMonth(year, month));
    return this.instantFromWall(year, month, day, f.hour, f.minute, f.second, f.millisecond);
  }

  /** `date(byAdding: .minute, value: n, to: t)`: absolute time. */
  addMinutes(t: number, n: number): number {
    return t + n * MS_PER_MINUTE;
  }

  /**
   * `dateComponents([.day], from: a, to: b).day`: whole days, counted on the wall clock (a
   * 23- or 25-hour day still counts as one), truncated toward zero.
   */
  daysBetween(a: number, b: number): number {
    const fa = this.fields(a);
    const fb = this.fields(b);
    const dayNumber = (f: WallFields) => {
      const d = new Date(0);
      d.setUTCFullYear(f.year, f.month - 1, f.day);
      return Math.round(d.getTime() / MS_PER_DAY);
    };
    let n = dayNumber(fb) - dayNumber(fa);
    if (b >= a) {
      while (n > 0 && this.addDays(a, n) > b) n -= 1;
      while (this.addDays(a, n + 1) <= b) n += 1;
    } else {
      while (n < 0 && this.addDays(a, n) < b) n += 1;
      while (this.addDays(a, n - 1) >= b) n -= 1;
    }
    return n;
  }
}

function clampInstant(t: number): number {
  return Math.max(-MAX_INSTANT, Math.min(MAX_INSTANT, t));
}

function pad(value: number, width: number): string {
  const negative = value < 0;
  const body = String(Math.abs(value)).padStart(negative ? width - 1 : width, "0");
  return negative ? `-${body}` : body;
}

/** Swift `Int(String)`: optional sign then ASCII digits, within Int64; otherwise null. */
export function parseSwiftInt(text: string): number | null {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const big = BigInt(text);
  if (big > 2n ** 63n - 1n || big < -(2n ** 63n)) return null;
  return Number(big);
}

/** UTC calendar with POSIX week rules (Sunday first, 1 day minimum): the parity harness's `Calendar.current`. */
export const UTC_POSIX_CALENDAR = new ZonedCalendar({ tz: "UTC", weekStart: 1, minDaysInFirstWeek: 1 });
