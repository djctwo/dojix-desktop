import { describe, expect, it } from "vitest";
import { UTC_POSIX_CALENDAR } from "./zoned-calendar";
import { dateRangeCutoff } from "./date-ranges";
import { formatGrdbDate, parseGrdbDate } from "./grdb-time";

describe("GRDB date text", () => {
  it("round-trips the stored format", () => {
    const t = Date.UTC(2026, 9, 23, 22, 50, 5, 123);
    expect(formatGrdbDate(t)).toBe("2026-10-23 22:50:05.123");
    expect(parseGrdbDate("2026-10-23 22:50:05.123")).toBe(t);
  });

  it("reads GRDB's other accepted forms", () => {
    expect(parseGrdbDate("2026-10-23")).toBe(Date.UTC(2026, 9, 23));
    expect(parseGrdbDate("2026-10-23 22:50")).toBe(Date.UTC(2026, 9, 23, 22, 50));
    expect(parseGrdbDate("2026-10-23T22:50:05")).toBe(Date.UTC(2026, 9, 23, 22, 50, 5));
    expect(parseGrdbDate("2026-10-23 22:50:05.1239")).toBe(Date.UTC(2026, 9, 23, 22, 50, 5, 123));
    expect(parseGrdbDate("2026-10-23 22:50:05Z")).toBe(Date.UTC(2026, 9, 23, 22, 50, 5));
    expect(parseGrdbDate("2026-10-23 22:50:05+02:00")).toBe(Date.UTC(2026, 9, 23, 20, 50, 5));
    expect(parseGrdbDate("2026-10-23 22:50:05-0130")).toBe(Date.UTC(2026, 9, 24, 0, 20, 5));
  });

  it("rejects invalid text", () => {
    for (const bad of ["", "2026-02-30", "2026-13-01", "2026-10-23 24:00", "23/10/2026", "2026-10-23 22:60"]) {
      expect(parseGrdbDate(bad)).toBeNull();
    }
    expect(() => formatGrdbDate(NaN)).toThrow(RangeError);
    expect(() => formatGrdbDate(Date.UTC(10000, 0, 1))).toThrow(RangeError);
  });

  it("Dojix date filters use the display calendar", () => {
    const now = Date.UTC(2026, 9, 23, 19, 30);
    expect(dateRangeCutoff("thisWeek", now, UTC_POSIX_CALENDAR)).toBe(Date.UTC(2026, 9, 18)); // Sunday
    expect(dateRangeCutoff("today", now, UTC_POSIX_CALENDAR)).toBe(Date.UTC(2026, 9, 23));
  });
});
