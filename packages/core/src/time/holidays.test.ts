import { describe, expect, it } from "vitest";
import { etWall } from "../test-support/trades";
import { easterSunday, nyseHolidayOn, nyseHolidays, usSessionClock } from "./holidays";

describe("NYSE full-day holidays", () => {
  it("2026", () => {
    expect(nyseHolidays(2026).map((h) => h.date)).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03", // 4 July is a Saturday
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ]);
  });

  it("2027 moves weekend holidays", () => {
    const dates = nyseHolidays(2027).map((h) => h.date);
    expect(dates).toContain("2027-03-26"); // Good Friday
    expect(dates).toContain("2027-06-18"); // Juneteenth on Saturday → Friday
    expect(dates).toContain("2027-07-05"); // 4 July on Sunday → Monday
    expect(dates).toContain("2027-12-24"); // Christmas on Saturday → Friday
  });

  it("does not move a Saturday New Year's Day and has no Juneteenth before 2022", () => {
    expect(nyseHolidays(2022).map((h) => h.date)).not.toContain("2021-12-31");
    expect(nyseHolidays(2022)[0]?.name).toBe("Martin Luther King Jr. Day");
    expect(nyseHolidays(2022).map((h) => h.date)).toContain("2022-06-20");
    expect(nyseHolidays(2021).some((h) => h.name === "Juneteenth")).toBe(false);
    expect(nyseHolidays(2023)[0]?.date).toBe("2023-01-02"); // Sunday → Monday
  });

  it("computes Easter", () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(easterSunday(2027)).toEqual({ month: 3, day: 28 });
    expect(easterSunday(2000)).toEqual({ month: 4, day: 23 });
    expect(nyseHolidayOn("2026-11-26")).toBe("Thanksgiving Day");
    expect(nyseHolidayOn("2026-11-27")).toBeNull();
  });
});

describe("usSessionClock (desktop sidebar clock)", () => {
  it("counts to the next boundary on a trading day", () => {
    const now = etWall(2026, 10, 23, 18, 50);
    const c = usSessionClock(now);
    expect(c).toMatchObject({ session: "AFTER_HOURS", closed: null, holiday: null, secondsLeft: 70 * 60 });
    expect(usSessionClock(etWall(2026, 10, 26, 3, 0))).toMatchObject({ session: "EXTENDED", secondsLeft: 3600 });
  });

  it("skips the weekend after Friday 20:00", () => {
    const now = etWall(2026, 10, 23, 20, 30);
    const c = usSessionClock(now);
    expect(c.session).toBe("EXTENDED");
    expect(c.nextChange).toBe(etWall(2026, 10, 26, 4, 0));
    const sat = usSessionClock(etWall(2026, 10, 24, 12, 0));
    expect(sat).toMatchObject({ session: null, closed: "weekend" });
    expect(sat.nextChange).toBe(etWall(2026, 10, 26, 4, 0));
  });

  it("shows holidays as closed and skips them", () => {
    const c = usSessionClock(etWall(2026, 11, 26, 10, 0));
    expect(c).toMatchObject({ session: null, closed: "holiday", holiday: "Thanksgiving Day" });
    expect(c.nextChange).toBe(etWall(2026, 11, 27, 4, 0));
    expect(usSessionClock(etWall(2027, 7, 2, 21, 0)).nextChange).toBe(etWall(2027, 7, 6, 4, 0));
  });

  it("measures real time across a daylight-saving night", () => {
    const now = etWall(2026, 3, 7, 12, 0); // Saturday, EST
    const c = usSessionClock(now);
    expect(c.nextChange).toBe(etWall(2026, 3, 9, 4, 0)); // Monday, EDT
    expect(c.secondsLeft).toBe(39 * 3600);
  });
});
