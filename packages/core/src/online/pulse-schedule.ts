// Danger zones and the Pulse recompute schedule (Dojix, SPEC 8.3, PARITY D-28).
//
// Port of `CalendarService.dangerZones` / `isInDangerZone` / `pairsAffectedBy`
// (Dojix `Services/LiveData/CalendarService.swift:96-160`) and the "today's events" filter in
// `PulseViewModel.loadCalendar` (`ViewModels/PulseViewModel.swift:62-88`).
//
// D-28 fix: the Mac computes the edge signal, and the active danger zone, once, when the
// screen appears (racing the calendar load). The desktop recomputes `computePulseEdgeSignals`
// whenever `pulseRefreshKey` changes, which happens when:
// - the UTC hour changes (the hour bucket and the active sessions only change on the hour);
// - a danger zone starts or ends;
// - a new copy of the calendar arrives.
// `nextPulseRefreshAt` says when to look again, so the UI sets one timer instead of polling.

import type { EngineContext } from "../engine/context";
import { fxActiveSessions, utcHour } from "../time/fx-sessions";
import type { ZonedCalendar } from "../time/zoned-calendar";
import type { CalendarWeek, EconomicEvent } from "./types";

/** ±15 minutes around a high-impact event. */
export const DANGER_ZONE_MS = 15 * 60_000;

export interface DangerZone {
  event: EconomicEvent;
  avoidStartMs: number;
  avoidEndMs: number;
  /** Mac pair names (no slash), as `pairsAffectedBy` returns them. */
  affectedPairs: string[];
}

/** `pairsAffectedBy(country:)`. */
export function pairsAffectedBy(country: string): string[] {
  switch (country.toUpperCase()) {
    case "USD":
      return ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"];
    case "EUR":
      return ["EURUSD", "EURGBP", "EURJPY"];
    case "GBP":
      return ["GBPUSD", "GBPJPY", "EURGBP"];
    case "JPY":
      return ["USDJPY", "GBPJPY", "EURJPY"];
    case "AUD":
      return ["AUDUSD", "AUDJPY"];
    case "CAD":
      return ["USDCAD"];
    case "CHF":
      return ["USDCHF"];
    case "NZD":
      return ["NZDUSD"];
    default:
      return [];
  }
}

/** `dangerZones(from:)`: one zone per high-impact event, in event order. */
export function dangerZones(events: readonly EconomicEvent[]): DangerZone[] {
  return events
    .filter((e) => e.impact === "high")
    .map((event) => ({
      event,
      avoidStartMs: event.timeMs - DANGER_ZONE_MS,
      avoidEndMs: event.timeMs + DANGER_ZONE_MS,
      affectedPairs: pairsAffectedBy(event.country),
    }));
}

/** `loadCalendar`: danger zones come from today's events only (the user's calendar day). */
export function todaysEvents(events: readonly EconomicEvent[], calendar: ZonedCalendar, now: number): EconomicEvent[] {
  return events.filter((e) => calendar.isSameDay(e.timeMs, now));
}

/** `isInDangerZone`: the first zone containing `now` (both ends inclusive). */
export function activeDangerZone(zones: readonly DangerZone[], now: number): DangerZone | null {
  return zones.find((z) => now >= z.avoidStartMs && now <= z.avoidEndMs) ?? null;
}

/** Today's zones and the active one at `ctx.now` (empty without a calendar). */
export function pulseDangerState(
  ctx: Pick<EngineContext, "calendar" | "now">,
  week: CalendarWeek | null,
): { zones: DangerZone[]; active: DangerZone | null } {
  if (week === null) return { zones: [], active: null };
  const zones = dangerZones(todaysEvents(week.events, ctx.calendar, ctx.now));
  return { zones, active: activeDangerZone(zones, ctx.now) };
}

/**
 * Everything the edge signal depends on besides the trades. When it changes, recompute
 * `computePulseEdgeSignals` (D-28).
 */
export function pulseRefreshKey(ctx: Pick<EngineContext, "calendar" | "now">, week: CalendarWeek | null): string {
  const { active } = pulseDangerState(ctx, week);
  const sessions = fxActiveSessions(ctx.now).join(",");
  const zone = active === null ? "-" : String(active.avoidStartMs);
  const loaded = week === null ? "-" : String(week.fetchedAtMs);
  return `${utcHour(ctx.now)}|${sessions}|${zone}|${loaded}`;
}

const HOUR_MS = 3_600_000;

/**
 * The next instant at which `pulseRefreshKey` can change on its own: the next UTC hour, or the
 * next start or end of one of today's danger zones (an end is passed 1 ms after it, because
 * the zone includes its end), or the next local midnight (today's events change).
 */
export function nextPulseRefreshAt(ctx: Pick<EngineContext, "calendar" | "now">, week: CalendarWeek | null): number {
  const now = ctx.now;
  let next = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const midnight = ctx.calendar.addDays(ctx.calendar.startOfDay(now), 1);
  if (midnight > now) next = Math.min(next, midnight);
  for (const z of pulseDangerState(ctx, week).zones) {
    for (const edge of [z.avoidStartMs, z.avoidEndMs + 1]) {
      if (edge > now && edge < next) next = edge;
    }
  }
  return next;
}
