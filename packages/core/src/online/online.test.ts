import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computePulseEdgeSignals } from "../analytics/pulse-edge-signal";
import { createEngineContext } from "../engine/context";
import { fxTrade } from "../test-support/trades";
import { currencyStrength } from "./currency-strength";
import {
  DANGER_ZONE_MS,
  activeDangerZone,
  dangerZones,
  nextPulseRefreshAt,
  pairsAffectedBy,
  pulseDangerState,
  pulseRefreshKey,
  todaysEvents,
} from "./pulse-schedule";
import { DOJIX_SECRET_ACCOUNTS, GREENWICK_SECRET_ACCOUNTS, type CalendarWeek, type EconomicEvent } from "./types";

const T = Date.UTC(2026, 9, 26, 12, 30); // Monday 26 Oct 2026, 12:30 UTC
const ctxAt = (now: number, tz = "UTC") => createEngineContext({ brand: "dojix", now, local: { tz } });

function ev(title: string, timeMs: number, impact: EconomicEvent["impact"] = "high", country = "USD"): EconomicEvent {
  return { title, country, timeMs, impact };
}

function week(events: EconomicEvent[], fetchedAtMs = T - 60_000): CalendarWeek {
  return { events, fetchedAtMs, source: "nfs.faireconomy.media", stale: false };
}

describe("danger zones (CalendarService.swift)", () => {
  it("covers ±15 minutes around high-impact events only", () => {
    const zones = dangerZones([ev("Fictional CPI", T), ev("Fictional PMI", T + 3_600_000, "medium"), ev("Fictional rate decision", T + 7_200_000, "high", "EUR")]);
    expect(zones.map((z) => z.event.title)).toEqual(["Fictional CPI", "Fictional rate decision"]);
    expect(zones[0]).toMatchObject({ avoidStartMs: T - DANGER_ZONE_MS, avoidEndMs: T + DANGER_ZONE_MS, affectedPairs: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"] });
    expect(activeDangerZone(zones, T - DANGER_ZONE_MS)?.event.title).toBe("Fictional CPI");
    expect(activeDangerZone(zones, T + DANGER_ZONE_MS)?.event.title).toBe("Fictional CPI");
    expect(activeDangerZone(zones, T + DANGER_ZONE_MS + 1)).toBeNull();
  });

  it("maps every Mac currency to its pairs", () => {
    expect(pairsAffectedBy("eur")).toEqual(["EURUSD", "EURGBP", "EURJPY"]);
    expect(pairsAffectedBy("GBP")).toEqual(["GBPUSD", "GBPJPY", "EURGBP"]);
    expect(pairsAffectedBy("JPY")).toEqual(["USDJPY", "GBPJPY", "EURJPY"]);
    expect(pairsAffectedBy("AUD")).toEqual(["AUDUSD", "AUDJPY"]);
    expect(pairsAffectedBy("CAD")).toEqual(["USDCAD"]);
    expect(pairsAffectedBy("CHF")).toEqual(["USDCHF"]);
    expect(pairsAffectedBy("NZD")).toEqual(["NZDUSD"]);
    expect(pairsAffectedBy("CNY")).toEqual([]);
  });

  it("uses today's events in the user's zone (PulseViewModel.loadCalendar)", () => {
    const lateTonight = Date.UTC(2026, 9, 26, 23, 30);
    const events = [ev("Today", T), ev("Late UTC", lateTonight)];
    expect(todaysEvents(events, ctxAt(T).calendar, T).map((e) => e.title)).toEqual(["Today", "Late UTC"]);
    // In Tokyo (UTC+9), 23:30 UTC on the 26th is already the 27th.
    expect(todaysEvents(events, ctxAt(T, "Asia/Tokyo").calendar, T).map((e) => e.title)).toEqual(["Today"]);
    expect(pulseDangerState(ctxAt(T), null)).toEqual({ zones: [], active: null });
    expect(pulseDangerState(ctxAt(T), week(events)).active?.event.title).toBe("Today");
  });
});

describe("D-28: the Pulse edge signal is recomputed when its inputs change", () => {
  it("the refresh key changes with the hour, a danger zone and a new calendar copy", () => {
    const w = week([ev("Fictional CPI", T + 30 * 60_000)]);
    const at = (t: number) => pulseRefreshKey(ctxAt(t), w);
    expect(at(T)).toBe(at(T + 60_000));
    expect(at(T + 16 * 60_000), "the zone starts at 12:45").not.toBe(at(T));
    expect(at(T + 31 * 60_000), "a new hour").not.toBe(at(T + 16 * 60_000));
    expect(pulseRefreshKey(ctxAt(T), null), "the calendar arrived").not.toBe(at(T));
    expect(pulseRefreshKey(ctxAt(T), week(w.events, T)), "a newer copy").not.toBe(at(T));
  });

  it("schedules the next check at the next hour, zone edge or midnight", () => {
    const w = week([ev("Fictional CPI", T + 30 * 60_000)]);
    expect(nextPulseRefreshAt(ctxAt(T), w)).toBe(T + 15 * 60_000); // the zone starts
    expect(nextPulseRefreshAt(ctxAt(T + 15 * 60_000), w)).toBe(T + 30 * 60_000); // 13:00
    expect(nextPulseRefreshAt(ctxAt(T + 31 * 60_000), w)).toBe(T + 45 * 60_000 + 1); // zone end
    expect(nextPulseRefreshAt(ctxAt(T), null)).toBe(Date.UTC(2026, 9, 26, 13));
    // Kolkata (+5:30): local midnight falls at 18:30 UTC, before the next UTC hour.
    const k = Date.UTC(2026, 9, 26, 18, 10);
    expect(nextPulseRefreshAt(ctxAt(k, "Asia/Kolkata"), null)).toBe(Date.UTC(2026, 9, 26, 18, 30));
  });

  it("the Mac misses the danger-zone penalty; recomputing on the new key applies it", () => {
    const trades = Array.from({ length: 40 }, (_, i) =>
      fxTrade({ netProfit: i % 3 === 0 ? "-20" : "40", session: "NY_OVERLAP", hour: 12, closeTime: T - (i + 1) * 86_400_000 }),
    );
    const w = week([ev("Fictional payrolls", T + 30 * 60_000)]);
    // Screen opened at 12:30, before the zone: the Mac computes once and keeps this.
    const before = computePulseEdgeSignals(ctxAt(T), trades, { activeDangerZone: pulseDangerState(ctxAt(T), w).active !== null });
    // 12:50 is inside the zone: the key changed, so the desktop recomputes.
    const inZone = T + 20 * 60_000;
    expect(pulseRefreshKey(ctxAt(inZone), w)).not.toBe(pulseRefreshKey(ctxAt(T), w));
    const after = computePulseEdgeSignals(ctxAt(inZone), trades, { activeDangerZone: pulseDangerState(ctxAt(inZone), w).active !== null });
    const score = (m: typeof before) => m.sessionEdgeSignals.map((s) => s.score);
    expect(score(after).every((s, i) => s === (score(before)[i] ?? 0) - 2)).toBe(true);
    expect(after.sessionEdgeSignals[0]?.signal.details).toContain("High-impact news active");
  });

  it("never schedules into the past (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }),
        fc.array(fc.integer({ min: -86_400_000, max: 86_400_000 }), { maxLength: 6 }),
        fc.constantFrom("UTC", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Adelaide", "America/New_York"),
        (now, offsets, tz) => {
          const w = week(offsets.map((o, i) => ev(`Fictional ${i}`, now + o)));
          const next = nextPulseRefreshAt(ctxAt(now, tz), w);
          expect(next).toBeGreaterThan(now);
          expect(next - now).toBeLessThanOrEqual(3_600_000);
          expect(typeof pulseRefreshKey(ctxAt(now, tz), w)).toBe("string");
        },
      ),
    );
  });
});

describe("currency strength (TwelveDataService.calculateStrength)", () => {
  it("adds the change to the base, subtracts it from the quote, normalises and sorts", () => {
    const s = currencyStrength([
      { symbol: "EUR/USD", changePercent: 0.5 },
      { symbol: "GBP/USD", changePercent: 0.25 },
      { symbol: "USD/JPY", changePercent: -0.25 },
      { symbol: "XAUUSD", changePercent: 9 },
    ]);
    // USD: -0.5 - 0.25 - 0.25 = -1; EUR 0.5; GBP 0.25; JPY 0.25.
    expect(s).toEqual([
      { currency: "USD", strength: -1 },
      { currency: "EUR", strength: 0.5 },
      { currency: "GBP", strength: 0.25 },
      { currency: "JPY", strength: 0.25 },
    ]);
  });

  it("is empty without movement or quotes, and survives hostile input", () => {
    expect(currencyStrength([])).toEqual([]);
    expect(currencyStrength([{ symbol: "EUR/USD", changePercent: 0 }])).toEqual([]);
    expect(currencyStrength([{ symbol: "EUR/USD", changePercent: Number.NaN }])).toEqual([]);
    fc.assert(
      fc.property(
        fc.array(fc.record({ symbol: fc.string({ maxLength: 9 }), changePercent: fc.double() }), { maxLength: 20 }),
        (quotes) => {
          for (const row of currencyStrength(quotes)) {
            expect(Number.isFinite(row.strength)).toBe(true);
            expect(Math.abs(row.strength)).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });
});

describe("secret accounts", () => {
  it("per brand, matching the shell's lists", () => {
    expect(DOJIX_SECRET_ACCOUNTS).not.toContain("finnhub_api_key");
    expect(GREENWICK_SECRET_ACCOUNTS).toEqual(["anthropic_api_key", "finnhub_api_key"]);
  });
});
