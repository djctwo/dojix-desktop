import type { EngineSettings } from "./protocol";

interface WeekInfo {
  firstDay: number;
  /** Dropped from newer engines (Node 25+, recent Chromium); see MIN_DAYS_4. */
  minimalDays?: number;
}

/**
 * Regions whose first week needs 4 days (ICU supplemental data, `minDays 4`); everywhere else
 * it is 1. Used when the engine's Intl no longer reports `minimalDays`.
 */
const MIN_DAYS_4 = new Set(
  "AD AN AT AX BE BG CH CZ DE DK EE ES FI FJ FO FR GB GF GG GI GP GR HU IE IM IS IT JE LI LT LU MC MQ NL NO PL PT RE RU SE SJ SK SM VA".split(
    " ",
  ),
);

/** "en-US" → "en_US" (the Foundation identifiers core's formatters take). */
export function foundationLocale(bcp47: string): string {
  return bcp47.replaceAll("-", "_");
}

/** The locale's week rule from Intl (1 = Monday … 7 = Sunday there), as Foundation numbers it (1 = Sunday). */
export function weekRule(bcp47: string): { weekStart: number; minDaysInFirstWeek: number } {
  try {
    const loc = new Intl.Locale(bcp47) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info) {
      const region = loc.maximize().region ?? "";
      const minDays = info.minimalDays ?? (MIN_DAYS_4.has(region) ? 4 : 1);
      return { weekStart: (info.firstDay % 7) + 1, minDaysInFirstWeek: minDays };
    }
  } catch {
    // Unknown tag: fall through to the en_US rule.
  }
  return { weekStart: 1, minDaysInFirstWeek: 1 };
}

/**
 * The engine settings of this computer: its zone, locale and the locale's week (the Mac's
 * `Calendar.current` / `Locale.current`). Settings → display zone and week start override them
 * (prefs, ui-tools).
 */
export function environmentSettings(): EngineSettings {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
  return {
    tz,
    locale: foundationLocale(lang),
    ...weekRule(lang),
    compat: "fixed",
    brokerOffset: "utc",
  };
}
