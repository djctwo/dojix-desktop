import { describe, expect, it } from "vitest";
import {
  fxActiveSessions,
  fxFileSessionForHour,
  fxSessionAt,
  fxSessionForHour,
  fxSidebarHoursLeft,
  fxTimeToNextSession,
  utcHour,
  utcShortDayName,
} from "./fx-sessions";

const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 0, 15, h, m, s);

describe("Date.tradingSession (Date+Forex.swift:17-30)", () => {
  // DojixTests/FormattingTests.swift:77-141
  it("matches the Mac's session tests", () => {
    expect(fxSessionAt(at(3))).toBe("ASIAN");
    expect(fxSessionAt(at(9))).toBe("LONDON");
    expect(fxSessionAt(at(14))).toBe("NY_OVERLAP");
    expect(fxSessionAt(at(18))).toBe("NY");
    expect(fxSessionAt(at(22))).toBe("LATE");
  });

  it("puts every boundary hour in the right bucket", () => {
    const expected = [
      ...Array(7).fill("ASIAN"),
      ...Array(5).fill("LONDON"),
      ...Array(4).fill("NY_OVERLAP"),
      ...Array(5).fill("NY"),
      ...Array(3).fill("LATE"),
    ];
    expect(Array.from({ length: 24 }, (_, h) => fxSessionForHour(h))).toEqual(expected);
    expect(fxSessionForHour(-1)).toBe("LATE");
    expect(fxSessionForHour(99)).toBe("LATE");
  });

  it("file buckets differ from the app buckets (SPEC §3.1)", () => {
    expect([0, 7, 8, 11, 12, 16, 17, 21, 22, 23].map(fxFileSessionForHour)).toEqual([
      "ASIAN",
      "ASIAN",
      "LONDON",
      "LONDON",
      "NY_OVERLAP",
      "NY_OVERLAP",
      "NY",
      "NY",
      "LATE",
      "LATE",
    ]);
    expect(fxSessionForHour(7)).toBe("LONDON");
    expect(fxFileSessionForHour(7)).toBe("ASIAN");
  });
});

describe("active sessions and countdowns", () => {
  it("lists overlapping windows (Date+Forex.swift:34-42)", () => {
    expect(fxActiveSessions(at(0))).toEqual(["ASIAN"]);
    expect(fxActiveSessions(at(8))).toEqual(["ASIAN", "LONDON"]);
    expect(fxActiveSessions(at(13))).toEqual(["LONDON", "NY"]);
    expect(fxActiveSessions(at(16))).toEqual(["NY"]);
    expect(fxActiveSessions(at(21))).toEqual(["LATE"]);
  });

  it("counts down to the next primary boundary, ignoring seconds", () => {
    expect(fxTimeToNextSession(at(6, 59, 59))).toBe(60);
    expect(fxTimeToNextSession(at(0, 0))).toBe(7 * 3600);
    expect(fxTimeToNextSession(at(11, 30))).toBe(30 * 60);
    expect(fxTimeToNextSession(at(15, 0))).toBe(3600);
    expect(fxTimeToNextSession(at(20, 15))).toBe(45 * 60);
    expect(fxTimeToNextSession(at(23, 0))).toBe(3600);
  });

  it("sidebar hours left use the active-window end (SidebarView.swift:308-320)", () => {
    expect(fxSidebarHoursLeft(at(0))).toBe(9); // tagged Asian until 07, counts to 09
    expect(fxSidebarHoursLeft(at(10))).toBe(6);
    expect(fxSidebarHoursLeft(at(13))).toBe(3);
    expect(fxSidebarHoursLeft(at(17))).toBe(4);
    expect(fxSidebarHoursLeft(at(22))).toBe(2);
  });
});

describe("UTC helpers", () => {
  it("reads the UTC hour and English weekday", () => {
    expect(utcHour(at(23, 59))).toBe(23);
    expect(utcShortDayName(at(1))).toBe("Thu");
    expect(() => utcHour(Number.NaN)).toThrow(RangeError);
  });
});
