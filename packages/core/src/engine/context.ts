// EngineContext (SPEC §3.2): every computation takes it explicitly, so no hidden dependency
// on the computer's clock, zone, locale or randomness remains.

import type { BrandId } from "../brand";
import { TRADING_CALENDAR } from "../time/us-market";
import { ZonedCalendar, type CalendarSpec } from "../time/zoned-calendar";
import type { CompatMode } from "./compat";
import { createRng, type Rng } from "./rng";

export interface EngineContext {
  brand: BrandId;
  /**
   * The brand calendar. Dojix: the user's display zone and locale week (the Mac's
   * `Calendar.current`). Greenwick: the fixed ET trading calendar.
   */
  calendar: ZonedCalendar;
  /**
   * The computer's calendar. Same as `calendar` for Dojix; for Greenwick it serves the few
   * components that use `Calendar.current` on the Mac (PeriodComparison cut-offs,
   * GrowthProjection, the EventImpactProfiler day span, the TradeCalendar grid's first weekday).
   */
  localCalendar: ZonedCalendar;
  /**
   * The user's locale as a Foundation identifier ("en_US", "en_GB", "ja_JP", "en_US_POSIX").
   * Text the Mac builds with `Locale.current` formatters (currency in insight and summary
   * text, `DateFormatter` month names) is formatted with it; see `swiftcompat/format.ts`.
   */
  locale: string;
  /** "Now" as epoch ms (injected in tests and parity runs). */
  now: number;
  rng: Rng;
  /** Dojix 32-column MT5 files: "utc" (Mac behaviour) or the broker's IANA zone. */
  brokerOffset: "utc" | string;
  compat: CompatMode;
}

export interface EngineContextOptions {
  brand: BrandId;
  now: number;
  /** The computer's / user's display calendar. Default: UTC, Sunday-first, minimum 1 day. */
  local?: Partial<CalendarSpec>;
  /** The user's locale (Foundation identifier). Default "en_US". */
  locale?: string;
  seed?: number;
  brokerOffset?: "utc" | string;
  compat?: CompatMode;
}

const DEFAULT_LOCAL: CalendarSpec = { tz: "UTC", weekStart: 1, minDaysInFirstWeek: 1 };

/** Builds a context. The app passes the user's settings; tests pass fixed values. */
export function createEngineContext(options: EngineContextOptions): EngineContext {
  if (!Number.isFinite(options.now)) throw new RangeError(`now must be finite, got ${options.now}`);
  const localCalendar = new ZonedCalendar({ ...DEFAULT_LOCAL, ...options.local });
  return {
    brand: options.brand,
    calendar: options.brand === "greenwick" ? TRADING_CALENDAR : localCalendar,
    localCalendar,
    locale: options.locale ?? "en_US",
    now: options.now,
    rng: createRng(options.seed ?? 0x5eed),
    brokerOffset: options.brokerOffset ?? "utc",
    compat: options.compat ?? "fixed",
  };
}

/** The environment a Tier B reference was computed in (its `tz`, `locale` and week rules). */
export interface ParityEnvironment {
  /** IANA zone as Foundation reports it ("GMT" when the harness ran with TZ=UTC). */
  tz: string;
  locale: string;
  firstWeekday: number;
  minimumDaysInFirstWeek: number;
}

/** The pinned harness environment (SPEC §10.2): `TZ=UTC`, `en_US_POSIX`, Sunday-first weeks, minimum 1 day. */
export const POSIX_PARITY_ENVIRONMENT: ParityEnvironment = {
  tz: "UTC",
  locale: "en_US_POSIX",
  firstWeekday: 1,
  minimumDaysInFirstWeek: 1,
};

/**
 * The context of a parity run: the reference file's "now", zone, locale and week rules, and
 * `compat: "swift"` (SPEC §10.2). Without `env`, the pinned harness environment.
 */
export function parityContext(
  brand: BrandId,
  now: number,
  env: ParityEnvironment = POSIX_PARITY_ENVIRONMENT,
  compat: CompatMode = "swift",
): EngineContext {
  return createEngineContext({
    brand,
    now,
    local: { tz: env.tz === "GMT" ? "UTC" : env.tz, weekStart: env.firstWeekday, minDaysInFirstWeek: env.minimumDaysInFirstWeek },
    locale: env.locale,
    compat,
  });
}
