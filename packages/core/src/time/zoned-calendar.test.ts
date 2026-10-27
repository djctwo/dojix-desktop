import { describe, expect, it } from "vitest";
import { etWall } from "../test-support/trades";
import { TRADING_CALENDAR } from "./us-market";
import { daysInMonth, daysInYear, isValidTimeZone, parseSwiftInt, UTC_POSIX_CALENDAR, ZonedCalendar } from "./zoned-calendar";

const H = 3_600_000;
const D = 24 * H;

describe("ZonedCalendar construction", () => {
  it("validates its spec", () => {
    expect(() => new ZonedCalendar({ tz: "UTC", weekStart: 0, minDaysInFirstWeek: 1 })).toThrow(RangeError);
    expect(() => new ZonedCalendar({ tz: "UTC", weekStart: 1, minDaysInFirstWeek: 8 })).toThrow(RangeError);
    expect(() => new ZonedCalendar({ tz: "Mars/Olympus", weekStart: 1, minDaysInFirstWeek: 1 })).toThrow(RangeError);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("nope")).toBe(false);
    expect(TRADING_CALENDAR.spec).toEqual({ tz: "America/New_York", weekStart: 2, minDaysInFirstWeek: 4 });
  });

  it("rejects instants outside Date's range", () => {
    expect(() => UTC_POSIX_CALENDAR.fields(NaN)).toThrow(RangeError);
    expect(() => TRADING_CALENDAR.fields(9e15)).toThrow(RangeError);
  });
});

describe("fields", () => {
  it("reads wall-clock fields in the zone (1 = Sunday)", () => {
    const t = Date.UTC(2026, 9, 23, 22, 50); // Fri 18:50 EDT
    expect(TRADING_CALENDAR.fields(t)).toMatchObject({ year: 2026, month: 10, day: 23, hour: 18, minute: 50, weekday: 6 });
    expect(TRADING_CALENDAR.weekdayName(t)).toBe("Fri");
    expect(UTC_POSIX_CALENDAR.weekdayName(t)).toBe("Fri");
    expect(new ZonedCalendar({ tz: "Asia/Tokyo", weekStart: 1, minDaysInFirstWeek: 1 }).weekdayName(t)).toBe("Sat");
    expect(UTC_POSIX_CALENDAR.fields(Date.UTC(2024, 11, 31)).dayOfYear).toBe(366);
    expect(UTC_POSIX_CALENDAR.fields(Date.UTC(2026, 0, 1, 0, 0, 0, 7)).millisecond).toBe(7);
  });

  it("handles zones with sub-hour and historical second offsets", () => {
    const kolkata = new ZonedCalendar({ tz: "Asia/Kolkata", weekStart: 1, minDaysInFirstWeek: 1 });
    expect(kolkata.offsetAt(Date.UTC(2026, 0, 1))).toBe(5.5 * H);
    const kathmandu = new ZonedCalendar({ tz: "Asia/Kathmandu", weekStart: 1, minDaysInFirstWeek: 1 });
    expect(kathmandu.fields(Date.UTC(2026, 0, 1, 0, 0)).minute).toBe(45);
    // New York local mean time −4:56:02 before 1883
    expect(TRADING_CALENDAR.offsetAt(Date.UTC(1880, 5, 1, 12))).toBe(-(4 * 3600 + 56 * 60 + 2) * 1000);
    expect(TRADING_CALENDAR.fields(Date.UTC(1880, 5, 1, 12))).toMatchObject({ hour: 7, minute: 3, second: 58 });
  });

  it("reads years before 1 AD through the era", () => {
    const t = Date.UTC(-5, 0, 1);
    expect(new ZonedCalendar({ tz: "Europe/Berlin", weekStart: 2, minDaysInFirstWeek: 4 }).fields(t).year).toBe(-5);
  });

  it("formats day and month keys zero-padded", () => {
    const t = Date.UTC(2026, 2, 8, 12);
    expect(UTC_POSIX_CALENDAR.dayKey(t)).toBe("2026-03-08");
    expect(UTC_POSIX_CALENDAR.monthKey(t)).toBe("2026-03");
    const early = new Date(0);
    early.setUTCFullYear(33, 0, 5);
    expect(UTC_POSIX_CALENDAR.dayKey(early.getTime())).toBe("0033-01-05");
    expect(UTC_POSIX_CALENDAR.dayKey(Date.UTC(-5, 0, 1))).toBe("-005-01-01");
  });

  it("knows weekends and minutes of the day", () => {
    expect(TRADING_CALENDAR.isWeekend(etWall(2026, 10, 24, 11, 0))).toBe(true);
    expect(TRADING_CALENDAR.isWeekend(etWall(2026, 10, 23, 23, 59))).toBe(false);
    expect(TRADING_CALENDAR.minuteOfDay(etWall(2026, 10, 23, 9, 30))).toBe(570);
    expect(TRADING_CALENDAR.hour(etWall(2026, 10, 23, 9, 30))).toBe(9);
    expect(TRADING_CALENDAR.minute(etWall(2026, 10, 23, 9, 30))).toBe(30);
  });
});

describe("daylight saving (America/New_York)", () => {
  it("days are 23 h / 25 h on the switch days (TradingDayTests.swift:207-218)", () => {
    const mar7 = TRADING_CALENDAR.startOfDay(etWall(2026, 3, 7, 12, 0));
    const mar8 = TRADING_CALENDAR.startOfDay(etWall(2026, 3, 8, 12, 0));
    const mar9 = TRADING_CALENDAR.startOfDay(etWall(2026, 3, 9, 12, 0));
    expect(mar8 - mar7).toBe(24 * H);
    expect(mar9 - mar8).toBe(23 * H);
    const nov1 = TRADING_CALENDAR.startOfDay(etWall(2026, 11, 1, 12, 0));
    const nov2 = TRADING_CALENDAR.startOfDay(etWall(2026, 11, 2, 12, 0));
    expect(nov2 - nov1).toBe(25 * H);
    expect(TRADING_CALENDAR.startOfDay(etWall(2026, 3, 15, 12, 0))).toBe(Date.UTC(2026, 2, 15, 4));
  });

  it("reads a skipped wall time with the earlier offset (02:30 → 03:30 EDT)", () => {
    expect(TRADING_CALENDAR.instantFromWall(2026, 3, 8, 2, 30)).toBe(Date.UTC(2026, 2, 8, 7, 30));
    expect(TRADING_CALENDAR.fields(Date.UTC(2026, 2, 8, 7, 30)).hour).toBe(3);
  });

  it("reads a repeated wall time as the first occurrence", () => {
    expect(TRADING_CALENDAR.instantFromWall(2026, 11, 1, 1, 30)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("rolls out-of-range fields over", () => {
    expect(TRADING_CALENDAR.instantFromWall(2026, 13, 1)).toBe(TRADING_CALENDAR.instantFromWall(2027, 1, 1));
    expect(UTC_POSIX_CALENDAR.instantFromWall(2026, 3, 0)).toBe(Date.UTC(2026, 1, 28));
  });
});

describe("startOfDay in zones where daylight saving starts at midnight", () => {
  for (const tz of ["America/Santiago", "Asia/Beirut", "America/Havana", "America/Asuncion"]) {
    it(`${tz}: the start is the first instant of the wall date`, () => {
      const cal = new ZonedCalendar({ tz, weekStart: 1, minDaysInFirstWeek: 1 });
      for (let day = 0; day < 366; day++) {
        const noon = Date.UTC(2023, 0, 1 + day, 15);
        const start = cal.startOfDay(noon);
        const f = cal.fields(noon);
        const s = cal.fields(start);
        expect([s.year, s.month, s.day]).toEqual([f.year, f.month, f.day]);
        expect(s.hour === 0 || s.hour === 1).toBe(true);
        expect(cal.isSameDay(start - 1, start)).toBe(false);
      }
    });
  }
});

/** Independent week numbering: week 1 is the first week with ≥ minDays days in the year. */
function referenceWeek(t: number, weekStart: number, minDays: number): { y: number; w: number } {
  const date = new Date(t);
  const dayNum = Math.floor(t / D);
  const weekday = date.getUTCDay() + 1;
  const weekStartNum = dayNum - ((weekday - weekStart + 7) % 7);
  const week1Start = (year: number) => {
    const jan1 = Math.floor(Date.UTC(year, 0, 1) / D);
    const jan1Weekday = new Date(Date.UTC(year, 0, 1)).getUTCDay() + 1;
    const rel = (jan1Weekday - weekStart + 7) % 7;
    return jan1 - rel + (7 - rel >= minDays ? 0 : 7);
  };
  const y = date.getUTCFullYear();
  for (const year of [y + 1, y, y - 1]) {
    const s = week1Start(year);
    if (weekStartNum >= s) return { y: year, w: (weekStartNum - s) / 7 + 1 };
  }
  throw new Error("unreachable");
}

function referenceWeekOfMonth(t: number, weekStart: number, minDays: number): number {
  const date = new Date(t);
  const day = date.getUTCDate();
  const firstWeekday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).getUTCDay() + 1;
  const rel = (firstWeekday - weekStart + 7) % 7;
  const week1StartDay = 1 - rel + (7 - rel >= minDays ? 0 : 7);
  return Math.floor((day - week1StartDay) / 7) + 1;
}

describe("week numbering (ICU rules) against an independent definition", () => {
  it("matches for every first weekday and minimum-days setting", () => {
    for (let weekStart = 1; weekStart <= 7; weekStart++) {
      for (let minDays = 1; minDays <= 7; minDays++) {
        const cal = new ZonedCalendar({ tz: "UTC", weekStart, minDaysInFirstWeek: minDays });
        for (let day = -20; day < 3 * 366 + 20; day += 1) {
          const t = Date.UTC(2024, 0, 1 + day, 12);
          const ref = referenceWeek(t, weekStart, minDays);
          const got = cal.weekOfYear(t);
          expect([got.yearForWeekOfYear, got.weekOfYear]).toEqual([ref.y, ref.w]);
          expect(cal.weekOfMonth(t)).toBe(referenceWeekOfMonth(t, weekStart, minDays));
          expect(cal.startOfWeekOfYear(got.yearForWeekOfYear, got.weekOfYear)).toBe(cal.startOfWeek(t));
        }
      }
    }
  });

  it("gives the known ISO weeks for the Greenwick calendar (Monday, 4 days)", () => {
    const iso = (y: number, m: number, d: number) => TRADING_CALENDAR.weekOfYear(etWall(y, m, d, 12, 0));
    expect(iso(2026, 1, 1)).toEqual({ yearForWeekOfYear: 2026, weekOfYear: 1 });
    expect(iso(2027, 1, 1)).toEqual({ yearForWeekOfYear: 2026, weekOfYear: 53 });
    expect(iso(2021, 1, 3)).toEqual({ yearForWeekOfYear: 2020, weekOfYear: 53 });
    expect(iso(2024, 12, 30)).toEqual({ yearForWeekOfYear: 2025, weekOfYear: 1 });
  });

  it("puts the first Friday of a Friday-start month in week 0 for Greenwick (D-19)", () => {
    // May 2026 starts on a Friday.
    expect(TRADING_CALENDAR.weekOfMonth(etWall(2026, 5, 1, 12, 0))).toBe(0);
    expect(UTC_POSIX_CALENDAR.weekOfMonth(Date.UTC(2026, 4, 1, 12))).toBe(1);
  });

  it("uses US weeks for the POSIX calendar (Sunday, 1 day)", () => {
    expect(UTC_POSIX_CALENDAR.weekOfYear(Date.UTC(2026, 11, 26))).toEqual({ yearForWeekOfYear: 2026, weekOfYear: 52 });
    expect(UTC_POSIX_CALENDAR.weekOfYear(Date.UTC(2026, 11, 27))).toEqual({ yearForWeekOfYear: 2027, weekOfYear: 1 });
  });
});

describe("weeks, months and arithmetic", () => {
  it("starts weeks on the configured weekday at local midnight", () => {
    const fridayEvening = etWall(2026, 10, 23, 19, 30);
    expect(TRADING_CALENDAR.startOfWeek(fridayEvening)).toBe(etWall(2026, 10, 19, 0, 0));
    expect(TRADING_CALENDAR.startOfMonth(etWall(2026, 7, 31, 18, 30))).toBe(etWall(2026, 7, 1, 0, 0));
    expect(UTC_POSIX_CALENDAR.startOfWeek(Date.UTC(2026, 9, 23, 19))).toBe(Date.UTC(2026, 9, 18));
    expect(TRADING_CALENDAR.daysInMonthOf(etWall(2026, 2, 10, 0, 0))).toBe(28);
  });

  it("adds days on the wall clock and months with clamping", () => {
    const sat = etWall(2026, 3, 7, 12, 0);
    expect(TRADING_CALENDAR.addDays(sat, 1)).toBe(etWall(2026, 3, 8, 12, 0)); // 23 h later
    expect(TRADING_CALENDAR.addDays(sat, 1) - sat).toBe(23 * H);
    expect(UTC_POSIX_CALENDAR.addMonths(Date.UTC(2026, 2, 31, 9), -1)).toBe(Date.UTC(2026, 1, 28, 9));
    expect(UTC_POSIX_CALENDAR.addMonths(Date.UTC(2024, 2, 31), -1)).toBe(Date.UTC(2024, 1, 29));
    expect(UTC_POSIX_CALENDAR.addMonths(Date.UTC(2026, 10, 30), 2)).toBe(Date.UTC(2027, 0, 30));
    expect(UTC_POSIX_CALENDAR.addMonths(Date.UTC(2026, 0, 15), -13)).toBe(Date.UTC(2024, 11, 15));
    expect(UTC_POSIX_CALENDAR.addMinutes(0, 90)).toBe(90 * 60_000);
  });

  it("counts whole days on the wall clock (dateComponents([.day], from:to:))", () => {
    const a = etWall(2026, 3, 7, 12, 0);
    expect(TRADING_CALENDAR.daysBetween(a, etWall(2026, 3, 8, 11, 59))).toBe(0);
    expect(TRADING_CALENDAR.daysBetween(a, etWall(2026, 3, 8, 12, 0))).toBe(1);
    expect(TRADING_CALENDAR.daysBetween(a, a)).toBe(0);
    expect(TRADING_CALENDAR.daysBetween(etWall(2026, 3, 8, 12, 0), a)).toBe(-1);
    expect(TRADING_CALENDAR.daysBetween(etWall(2026, 3, 8, 11, 0), a)).toBe(0);
    expect(UTC_POSIX_CALENDAR.daysBetween(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31, 23))).toBe(364);
  });

  it("parses day keys like TradingCalendar.date(fromDayKey:)", () => {
    expect(TRADING_CALENDAR.dateFromDayKey("2026-10-23")).toBe(etWall(2026, 10, 23, 0, 0));
    expect(TRADING_CALENDAR.dateFromDayKey("-2026-10-23")).toBe(etWall(2026, 10, 23, 0, 0));
    expect(TRADING_CALENDAR.dateFromDayKey("2026-13-01")).toBe(etWall(2027, 1, 1, 0, 0));
    expect(TRADING_CALENDAR.dateFromDayKey("+2026-1-5")).toBe(etWall(2026, 1, 5, 0, 0));
    expect(TRADING_CALENDAR.dateFromDayKey("2026-10")).toBeNull();
    expect(TRADING_CALENDAR.dateFromDayKey("2026-10-x")).toBeNull();
    expect(TRADING_CALENDAR.dateFromDayKey("999999999-01-01")).toBeNull();
  });
});

describe("helpers", () => {
  it("daysInMonth / daysInYear", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2026)).toBe(365);
  });

  it("parseSwiftInt follows Int(String)", () => {
    expect(parseSwiftInt("+5")).toBe(5);
    expect(parseSwiftInt("-05")).toBe(-5);
    expect(parseSwiftInt(" 5")).toBeNull();
    expect(parseSwiftInt("5.0")).toBeNull();
    expect(parseSwiftInt("9223372036854775808")).toBeNull();
    expect(parseSwiftInt("")).toBeNull();
  });
});
