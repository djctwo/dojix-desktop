// Stored time text. Both Mac apps store dates through GRDB as UTC text
// "YYYY-MM-DD HH:MM:SS.SSS" and compare them as strings (SPEC §3.1); the desktop schema keeps
// the same text (SPEC §4.1).

const GRDB_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses GRDB date text (UTC): "YYYY-MM-DD", "YYYY-MM-DD HH:MM", "YYYY-MM-DD HH:MM:SS",
 * "YYYY-MM-DD HH:MM:SS.SSS" (a "T" separator and a trailing "Z" or ±HH:MM offset are also
 * read, as GRDB does). Fractions beyond milliseconds are truncated. Returns null when invalid.
 */
export function parseGrdbDate(text: string): number | null {
  const m = GRDB_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  if (date.getUTCDate() !== day) return null; // 31 February etc.
  let t = date.getTime();
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  return t;
}

/** Formats an instant as GRDB text "YYYY-MM-DD HH:MM:SS.SSS" (UTC). Years 0–9999 only. */
export function formatGrdbDate(t: number): string {
  const d = new Date(t);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(t) || year < 0 || year > 9999) throw new RangeError(`cannot store instant ${t}`);
  const p = (v: number, w = 2) => String(v).padStart(w, "0");
  return (
    `${p(year, 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}
