// Journal / Dashboard date filters (All / Today / This Week / This Month / 30d / 90d).
//
// Dojix: `Calendar.current` (the display calendar), Dojix `ViewModels/JournalViewModel.swift:93-104`
// and `DashboardViewModel.swift:176-186`. Greenwick: the ET trading calendar,
// Greenwick `ViewModels/JournalViewModel.swift:99-109`. A trade passes when its close time is at
// or after the cutoff.

import type { ZonedCalendar } from "./zoned-calendar";

export type DateRangeFilter = "all" | "today" | "thisWeek" | "thisMonth" | "last30" | "last90";

/** Swift `Date.distantPast` (year 1, as epoch ms) — before every storable date. */
export const DISTANT_PAST = -62_135_596_800_000;

/** The cutoff instant for a filter, on the brand calendar (`ctx.calendar`). */
export function dateRangeCutoff(range: DateRangeFilter, now: number, calendar: ZonedCalendar): number {
  switch (range) {
    case "all":
      return DISTANT_PAST;
    case "today":
      return calendar.startOfDay(now);
    case "thisWeek":
      return calendar.startOfWeek(now);
    case "thisMonth":
      return calendar.startOfMonth(now);
    case "last30":
      return calendar.addDays(now, -30);
    case "last90":
      return calendar.addDays(now, -90);
  }
}
