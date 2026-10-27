// The desktop engine functions registered for parity checking.
//
// Phase 0 ships this map empty: the reference files exist, the engine does not yet. Phase 2
// registers one function per reference key as it ports each formula, e.g.
//
//   import { calculateMetrics } from "@dojix-desktop/core";
//   export const engines: Record<Brand, EngineMap> = {
//     dojix: { "outputs.Metrics": (doc) => calculateMetrics(journalOf(doc), contextOf(doc)) },
//     greenwick: { … },
//   };
//
// `journalOf(doc)` turns `doc.import.journal` (the trades exactly as the Mac stored them) into
// engine trades; `contextOf(doc)` builds the EngineContext from doc.now / tz / locale /
// firstWeekday (SPEC §3.2).
import type { EngineMap, ReferenceDoc } from "./check.ts";

export type Brand = "dojix" | "greenwick";

export const engines: Record<Brand, EngineMap> = {
  dojix: {},
  greenwick: {},
};

/** The stored trades a reference was computed from (close time descending, as on the Mac). */
export function journalOf(doc: ReferenceDoc): Record<string, unknown>[] {
  return doc.import.journal ?? [];
}

/** Engine context values recorded by the Swift harness. */
export function contextOf(doc: ReferenceDoc): { now: number; tz: string; locale: string; weekStart: number; minDaysInFirstWeek: number } {
  return {
    now: Date.parse(doc.now),
    tz: doc.tz,
    locale: doc.locale,
    weekStart: doc.firstWeekday,
    minDaysInFirstWeek: doc.minimumDaysInFirstWeek,
  };
}
