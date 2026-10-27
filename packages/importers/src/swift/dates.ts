// Foundation date parsing the Mac importers use, reproduced for the patterns they need.
//
// `DateFormatter` with the POSIX locale and `isLenient == false` (ICU SimpleDateFormat):
// - numeric fields take as many ASCII digits as are present (no width limit when the next
//   pattern item is a literal) and are range-checked: month 1–12, day 1–(days in that month),
//   hour 0–23 (`H`) / 1–12 (`h`), minute and second 0–59; year ≥ 1;
// - a two-digit `yy` value uses ICU's sliding century: 80 years before to 20 years after "now";
// - literals must match exactly and the whole string must be consumed (`date(from:)`);
// - `Z` accepts "Z", ±HH, ±HHMM, ±HH:MM and "GMT"/"UTC" with an optional offset;
// - wall times are read in the formatter's zone (UTC, or America/New_York for Greenwick);
//   a wall time skipped by DST is read with the earlier offset (ZonedCalendar).
//
// `ISO8601DateFormatter` with `.withInternetDateTime` (optionally `.withFractionalSeconds`):
// `yyyy-MM-ddTHH:mm:ss[.fff]` followed by "Z" or ±HH:MM (±HHMM also read).

import { ZonedCalendar } from "@dojix-desktop/core";

export type TimeZoneId = "UTC" | "America/New_York";

const calendars = new Map<string, ZonedCalendar>();
function calendarFor(tz: string): ZonedCalendar {
  let c = calendars.get(tz);
  if (!c) {
    c = new ZonedCalendar({ tz, weekStart: 1, minDaysInFirstWeek: 1 });
    calendars.set(tz, c);
  }
  return c;
}

type Token =
  | { kind: "literal"; text: string }
  | { kind: "field"; letter: string; count: number };

const compiled = new Map<string, Token[] | null>();

/** Splits an ICU pattern into fields and literals; null for letters this parser doesn't know. */
export function compilePattern(pattern: string): Token[] | null {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const tokens: Token[] = [];
  let ok = true;
  let i = 0;
  const pushLiteral = (s: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.kind === "literal") last.text += s;
    else tokens.push({ kind: "literal", text: s });
  };
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "'") {
      if (pattern[i + 1] === "'") {
        pushLiteral("'");
        i += 2;
        continue;
      }
      let j = i + 1;
      let text = "";
      while (j < pattern.length) {
        if (pattern[j] === "'") {
          if (pattern[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        text += pattern[j];
        j++;
      }
      pushLiteral(text);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let n = 1;
      while (pattern[i + n] === c) n++;
      if (!"yMdHhmsSaZXx".includes(c)) ok = false;
      tokens.push({ kind: "field", letter: c, count: n });
      i += n;
      continue;
    }
    pushLiteral(c);
    i++;
  }
  const result = ok && tokens.length > 0 ? tokens : null;
  compiled.set(pattern, result);
  return result;
}

interface Parsed {
  year?: number;
  twoDigitYear?: boolean;
  month?: number;
  day?: number;
  hour24?: number;
  hour12?: number;
  pm?: boolean;
  minute?: number;
  second?: number;
  millis?: number;
  offsetMinutes?: number;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Parses `text` against an ICU pattern in `tz`. `now` (epoch ms) anchors two-digit years. Returns epoch ms or null. */
export function parseDatePattern(text: string, pattern: string, tz: TimeZoneId, now: number): number | null {
  const tokens = compilePattern(pattern);
  if (!tokens) return null;
  const p: Parsed = {};
  let pos = 0;
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti] as Token;
    if (tok.kind === "literal") {
      if (!text.startsWith(tok.text, pos)) return null;
      pos += tok.text.length;
      continue;
    }
    const next = tokens[ti + 1];
    const abutting = next !== undefined && next.kind === "field" && "yMdHhmsS".includes(next.letter);
    if (tok.letter === "a") {
      const am = text.startsWith("AM", pos) || text.startsWith("am", pos);
      const pm = text.startsWith("PM", pos) || text.startsWith("pm", pos);
      if (!am && !pm) return null;
      p.pm = pm;
      pos += 2;
      continue;
    }
    if (tok.letter === "Z" || tok.letter === "X" || tok.letter === "x") {
      const tzResult = parseZone(text, pos);
      if (!tzResult) return null;
      p.offsetMinutes = tzResult.offsetMinutes;
      pos = tzResult.end;
      continue;
    }
    // Numeric field.
    let end = pos;
    const maxWidth = abutting ? tok.count : Infinity;
    while (end < text.length && end - pos < maxWidth && isDigit(text.charCodeAt(end))) end++;
    if (end === pos) return null;
    const digits = text.slice(pos, end);
    if (digits.length > 12) return null;
    const value = Number(digits);
    switch (tok.letter) {
      case "y":
        p.year = value;
        p.twoDigitYear = tok.count <= 2 && digits.length === 2;
        break;
      case "M":
        if (tok.count >= 3) return null;
        p.month = value;
        break;
      case "d":
        p.day = value;
        break;
      case "H":
        p.hour24 = value;
        break;
      case "h":
        p.hour12 = value;
        break;
      case "m":
        p.minute = value;
        break;
      case "s":
        p.second = value;
        break;
      case "S":
        p.millis = Math.trunc(value * 10 ** (3 - digits.length));
        break;
      /* c8 ignore next 2 */
      default:
        return null;
    }
    pos = end;
  }
  if (pos !== text.length) return null;
  return resolve(p, tz, now);
}

function parseZone(text: string, pos: number): { offsetMinutes: number; end: number } | null {
  if (text.startsWith("Z", pos)) return { offsetMinutes: 0, end: pos + 1 };
  let i = pos;
  if (text.startsWith("GMT", i) || text.startsWith("UTC", i)) {
    i += 3;
    if (i === text.length || (text[i] !== "+" && text[i] !== "-")) return { offsetMinutes: 0, end: i };
  }
  const sign = text[i];
  if (sign !== "+" && sign !== "-") return null;
  i++;
  const m = /^(\d{2})(?::?(\d{2}))?/.exec(text.slice(i, i + 5));
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = m[2] === undefined ? 0 : Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  const offset = (hours * 60 + minutes) * (sign === "-" ? -1 : 1);
  return { offsetMinutes: offset, end: i + (m[0] as string).length };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * DateFormatter's reading of a wall time in a DST zone (Swift reference run, golden/reference):
 * a wall time skipped by the spring-forward change is rejected (nil), and a repeated one (the
 * autumn hour) resolves to its SECOND occurrence.
 */
function wallToInstant(cal: ZonedCalendar, y: number, month: number, day: number, hour: number, minute: number, second: number, millis: number): number | null {
  const t = cal.instantFromWall(y, month, day, hour, minute, second, millis);
  const f = cal.fields(t);
  if (f.year !== y || f.month !== month || f.day !== day || f.hour !== hour || f.minute !== minute) return null; // skipped
  const later = t + 3_600_000;
  const g = cal.fields(later);
  return g.year === y && g.month === month && g.day === day && g.hour === hour && g.minute === minute ? later : t;
}

function utcInstant(year: number, month: number, day: number, hour: number, minute: number, second: number, millis: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, millis);
  return d.getTime();
}

function resolve(p: Parsed, tz: TimeZoneId, now: number): number | null {
  let year = p.year ?? 1970;
  const month = p.month ?? 1;
  const day = p.day ?? 1;
  let hour = 0;
  if (p.hour24 !== undefined) {
    if (p.hour24 > 23) return null;
    hour = p.hour24;
  } else if (p.hour12 !== undefined) {
    if (p.hour12 < 1 || p.hour12 > 12) return null;
    hour = (p.hour12 % 12) + (p.pm ? 12 : 0);
  } else if (p.pm) hour = 12;
  const minute = p.minute ?? 0;
  const second = p.second ?? 0;
  const millis = p.millis ?? 0;
  if (minute > 59 || second > 59) return null;
  if (month < 1 || month > 12) return null;
  let centuryStart: number | null = null;
  let ambiguousYear = false;
  if (p.twoDigitYear === true) {
    // ICU: the default century starts 80 years before "now".
    const start = new Date(now);
    start.setUTCFullYear(start.getUTCFullYear() - 80);
    centuryStart = start.getTime();
    const startYear = start.getUTCFullYear();
    const ambiguous = startYear % 100;
    ambiguousYear = year === ambiguous;
    year += Math.trunc(startYear / 100) * 100 + (year < ambiguous ? 100 : 0);
  }
  const instant = (y: number): number | null => {
    if (y < 1 || y > 275_000) return null;
    if (day < 1 || day > daysInMonth(y, month)) return null;
    if (p.offsetMinutes !== undefined) return utcInstant(y, month, day, hour, minute, second, millis) - p.offsetMinutes * 60_000;
    if (tz === "UTC") return utcInstant(y, month, day, hour, minute, second, millis);
    if (y > 9999) return null;
    return wallToInstant(calendarFor(tz), y, month, day, hour, minute, second, millis);
  };
  let t = instant(year);
  if (t !== null && ambiguousYear && centuryStart !== null && t < centuryStart) t = instant(year + 100);
  return t !== null && Number.isFinite(t) ? t : null;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * `ISO8601DateFormatter` with `.withInternetDateTime` (+ `.withFractionalSeconds` when
 * `fractional`). The fractional form requires a fraction; the plain form refuses one.
 */
export function parseIso8601(text: string, fractional: boolean): number | null {
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string];
  if ((frac !== undefined) !== fractional) return null;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = frac === undefined ? 0 : Number(frac.padEnd(3, "0").slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  let t = date.getTime();
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 23 || om > 59) return null;
    t -= sign * (oh * 60 + om) * 60_000;
  }
  return t;
}

/** A list of patterns tried in order (de-duplicated, as both Macs do), then ISO 8601 with and without fractions. */
export class DateParsers {
  private readonly patterns: string[];

  constructor(
    patterns: readonly string[],
    private readonly tz: TimeZoneId,
    private readonly now: number,
    private readonly maxLength = Infinity,
  ) {
    this.patterns = [...new Set(patterns)];
  }

  parse(raw: string, trim: (s: string) => string): number | null {
    const trimmed = trim(raw);
    if (trimmed === "" || [...trimmed].length > this.maxLength) return null;
    for (const pattern of this.patterns) {
      const t = parseDatePattern(trimmed, pattern, this.tz, this.now);
      if (t !== null) return t;
    }
    return parseIso8601(trimmed, true) ?? parseIso8601(trimmed, false);
  }
}
