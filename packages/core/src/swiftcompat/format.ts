// Swift / Foundation number formatting, reproduced exactly where JS differs.
//
// `String(format: "%.2f", x)` goes through the C library's printf, which formats the *exact*
// binary value of the double and rounds ties to even. JS `toFixed` also uses the exact value
// but rounds ties *up* ("pick the larger n"), so 0.125.toFixed(2) is "0.13" where printf gives
// "0.12". It also prints "0.00" for -0 (printf: "-0.00"), "NaN"/"Infinity" (printf: "nan"/"inf")
// and switches to exponent notation at 1e21. `formatFixed` below is printf.

import { INT_MAX } from "./int";

interface ExactBinary {
  negative: boolean;
  /** |x| = mantissa × 2^exponent2 */
  mantissa: bigint;
  exponent2: number;
}

function decompose(x: number): ExactBinary {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const biased = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return { negative, mantissa: frac, exponent2: -1074 };
  return { negative, mantissa: frac | (1n << 52n), exponent2: biased - 1075 };
}

/** |x| × 10^digits rounded half-to-even to an integer, exactly. */
function scaledHalfEven(b: ExactBinary, digits: number): bigint {
  const pow10 = 10n ** BigInt(digits);
  if (b.exponent2 >= 0) return (b.mantissa << BigInt(b.exponent2)) * pow10;
  const num = b.mantissa * pow10;
  const den = 1n << BigInt(-b.exponent2);
  const q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && q % 2n === 1n)) return q + 1n;
  return q;
}

function insertPoint(digits: string, precision: number): string {
  if (precision === 0) return digits;
  const padded = digits.padStart(precision + 1, "0");
  return `${padded.slice(0, -precision)}.${padded.slice(-precision)}`;
}

/**
 * printf `%.<precision>f` of a double (Darwin libc behaviour): exact binary value, ties to
 * even, "-" kept for negative zero and for negatives that round to zero, "nan" / "inf" /
 * "-inf" for non-finite values, never exponent notation.
 */
export function formatFixed(x: number, precision = 6): string {
  if (!Number.isInteger(precision) || precision < 0 || precision > 100) {
    throw new RangeError(`unsupported precision ${precision}`);
  }
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const b = decompose(x);
  const body = insertPoint(scaledHalfEven(b, precision).toString(), precision);
  return b.negative ? `-${body}` : body;
}

type FormatArg = number | string | bigint;

interface Spec {
  flags: string;
  width: number | null;
  precision: number | null;
  conversion: string;
}

const SPEC_RE = /%([-+ 0#]*)(\d+)?(?:\.(\d+))?(?:hh|h|ll|l|q|z|t|j)?([diufFs@%])/g;
const ANY_SPEC_RE = /%[-+ 0#]*\d*(?:\.\d+)?(?:hh|h|ll|l|q|z|t|j)?([\s\S]?)/g;
const SUPPORTED = ["d", "i", "u", "f", "F", "s", "@", "%"];

function pad(body: string, spec: Spec, numeric: boolean): string {
  const width = spec.width ?? 0;
  if (body.length >= width) return body;
  if (spec.flags.includes("-")) return body.padEnd(width, " ");
  if (numeric && spec.flags.includes("0") && !/[a-z]/i.test(body)) {
    const sign = /^[-+ ]/.test(body) ? (body[0] as string) : "";
    const digits = sign ? body.slice(1) : body;
    return sign + digits.padStart(width - sign.length, "0");
  }
  return body.padStart(width, " ");
}

function signed(body: string, negative: boolean, flags: string): string {
  if (negative) return `-${body}`;
  if (flags.includes("+")) return `+${body}`;
  if (flags.includes(" ")) return ` ${body}`;
  return body;
}

function formatInteger(arg: FormatArg, spec: Spec): string {
  let n: bigint;
  if (typeof arg === "bigint") n = arg;
  else if (typeof arg === "number") {
    if (!Number.isInteger(arg)) throw new TypeError(`%${spec.conversion} needs an Int, got ${arg}`);
    // INT_MAX stands for Swift's Int.max (see int.ts); print the Swift digits.
    n = arg >= INT_MAX ? 2n ** 63n - 1n : BigInt(arg);
  } else throw new TypeError(`%${spec.conversion} needs an Int, got a string`);
  const negative = n < 0n;
  let digits = (negative ? -n : n).toString();
  if (spec.precision !== null) digits = digits.padStart(spec.precision, "0");
  return pad(signed(digits, negative, spec.flags), spec, spec.precision === null);
}

function formatDouble(arg: FormatArg, spec: Spec): string {
  if (typeof arg !== "number") throw new TypeError(`%${spec.conversion} needs a Double`);
  const body = formatFixed(arg, spec.precision ?? 6);
  const negative = body.startsWith("-");
  const unsigned = negative ? body.slice(1) : body;
  const text = spec.conversion === "F" ? unsigned.toUpperCase() : unsigned;
  return pad(signed(text, negative, spec.flags), spec, true);
}

/**
 * Swift `String(format:_:)` for the conversions the two apps use: `%d %i %u` (Int), `%f %F`
 * (Double, see `formatFixed`), `%@ %s` (String) and `%%`, with flags `- + space 0`, a width
 * and a precision. Length modifiers (`%ld`, `%lld`) are accepted and ignored. Any other
 * conversion throws, so an unported format string fails loudly in tests.
 */
export function swiftFormat(format: string, ...args: FormatArg[]): string {
  for (const m of format.matchAll(ANY_SPEC_RE)) {
    if (!SUPPORTED.includes(m[1] ?? "")) {
      throw new RangeError(`unsupported conversion %${m[1] ?? ""} in ${JSON.stringify(format)}`);
    }
  }
  let next = 0;
  return format.replace(SPEC_RE, (_m, flags: string, width?: string, precision?: string, conv?: string) => {
    const spec: Spec = {
      flags,
      width: width === undefined ? null : Number(width),
      precision: precision === undefined ? null : Number(precision),
      conversion: conv ?? "",
    };
    if (spec.conversion === "%") return "%";
    if (next >= args.length) throw new RangeError(`missing argument for %${spec.conversion}`);
    const arg = args[next++] as FormatArg;
    switch (spec.conversion) {
      case "d":
      case "i":
      case "u":
        return formatInteger(arg, spec);
      case "f":
      case "F":
        return formatDouble(arg, spec);
      default: {
        let s = String(arg);
        if (spec.precision !== null) s = s.slice(0, spec.precision);
        return pad(s, spec, false);
      }
    }
  });
}

// --- Foundation NumberFormatter (currency) ------------------------------------------------

/**
 * Rounds a double the way ICU's NumberFormatter does: it starts from the *shortest*
 * round-trip decimal digits of the double (not its exact binary value) and rounds those
 * half-to-even. So 2.675 (binary 2.67499999…) becomes "2.68" here but "2.67" with printf.
 * Returns the digits with a decimal point and `fractionDigits` decimals, unsigned.
 */
export function icuRoundHalfEven(x: number, fractionDigits: number): string {
  const abs = Math.abs(x);
  const [mant = "0", expText = "0"] = abs.toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expText);
  // value = 0.d1d2d3… × 10^(exp+1); scale to an integer string with fractionDigits decimals.
  const pointPos = exp + 1; // digits before the decimal point
  const keep = pointPos + fractionDigits; // number of leading digits kept
  let kept: bigint;
  if (keep < 0) kept = 0n;
  else if (keep >= digits.length) kept = BigInt(digits + "0".repeat(keep - digits.length));
  else {
    const head = keep === 0 ? 0n : BigInt(digits.slice(0, keep));
    const rest = digits.slice(keep);
    const first = Number(rest[0]);
    const tail = rest.slice(1).replace(/0+$/, "");
    let up = false;
    if (first > 5 || (first === 5 && tail.length > 0)) up = true;
    else if (first === 5) up = head % 2n === 1n;
    kept = up ? head + 1n : head;
  }
  return insertPoint(kept.toString(), fractionDigits);
}

// --- Locale (Foundation `Locale.current`) ------------------------------------------------

/** True for Foundation's `en_US_POSIX` (the Tier B harness pin, SPEC §10.2). */
export function isPosixLocale(locale: string): boolean {
  return /^en[-_]US[-_]POSIX$/i.test(locale);
}

/**
 * A Foundation locale identifier as a BCP 47 tag for Intl ("en_GB" → "en-GB"). Unknown or
 * malformed identifiers fall back to "en-US", like Foundation falls back to root data.
 */
export function bcp47(locale: string): string {
  const tag = locale.split("@")[0]?.replace(/_/g, "-") ?? "";
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

const currencyFormats = new Map<string, Intl.NumberFormat>();

function currencyFormat(locale: string): Intl.NumberFormat {
  let f = currencyFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(bcp47(locale), {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyFormats.set(locale, f);
  }
  return f;
}

/**
 * `Double.asCurrency` (both apps, `Extensions/Double+Formatting.swift:5-17`): a NumberFormatter
 * with `.currency`, currency code USD and two fraction digits, in the user's locale
 * (`Locale.current`; the desktop passes `ctx.locale`). So "$1,234.56" / "-$1,234.56" in en_US,
 * "US$1,234.56" in en_GB, "$1,23,456.78" in en_IN, and "$\u00a01234.56" / "-$\u00a01234.56"
 * (no grouping) in en_US_POSIX, the Tier B harness locale.
 *
 * The digits are ICU's: the shortest round-trip decimal of the double, rounded half-to-even
 * (`icuRoundHalfEven`); Intl only lays out the locale's symbol, sign and grouping around that
 * exact decimal text. NaN is "NaN" in every locale, as in ICU.
 */
export function asCurrency(x: number, locale: string): string {
  if (Number.isNaN(x)) return "NaN";
  const negative = x < 0 || Object.is(x, -0);
  if (isPosixLocale(locale)) {
    const body = Number.isFinite(x) ? icuRoundHalfEven(x, 2) : "∞";
    return `${negative ? "-" : ""}$\u00a0${body}`;
  }
  if (!Number.isFinite(x)) return currencyFormat(locale).format(x);
  const digits = icuRoundHalfEven(x, 2);
  // Intl formats a decimal string exactly (no second rounding); "-0.00" keeps its sign.
  return currencyFormat(locale).format((negative ? `-${digits}` : digits) as unknown as number);
}

/** `Double.asPips` (Dojix `Double+Formatting.swift:20-22`): "12.5 pips". */
export function asPips(x: number): string {
  return `${formatFixed(x, 1)} pips`;
}

/** `Double.asPoints` (Greenwick `Double+Formatting.swift:20-22`): "12.5 pts". */
export function asPoints(x: number): string {
  return `${formatFixed(x, 1)} pts`;
}

/** `Double.asPercent` (both apps): "65.4%". */
export function asPercent(x: number): string {
  return `${formatFixed(x, 1)}%`;
}

/** `Double.asRMultiple` (both apps): "1.50R". */
export function asRMultiple(x: number): string {
  return `${formatFixed(x, 2)}R`;
}

/** `Double.asProfitFactor` (both apps, `Double+Formatting.swift:35-38`): ±∞ shows as "99.99". */
export function asProfitFactor(x: number): string {
  if (x === Infinity || x === -Infinity) return "99.99";
  return formatFixed(x, 2);
}

/**
 * `Double.asCompactCurrency` (both apps, `Double+Formatting.swift:41-50`): "$1.2K", "-$15.3M"
 * (fixed text in every locale); below 1,000 it is `asCurrency` in the user's locale.
 */
export function asCompactCurrency(x: number, locale: string): string {
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${formatFixed(abs / 1_000_000, 1)}M`;
  if (abs >= 1_000) return `${sign}$${formatFixed(abs / 1_000, 1)}K`;
  return asCurrency(x, locale);
}

// --- DateFormatter month names ----------------------------------------------------------------

const POSIX_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const monthNames = new Map<string, readonly string[]>();

/**
 * The "MMM" field of a `DateFormatter` with a fixed `dateFormat` and the default locale
 * (`Locale.current`): "Mar" in en_US / en_US_POSIX, "Sept" in en_GB, "3月" in ja_JP.
 * `month` is 1 … 12.
 */
export function monthAbbreviation(month: number, locale: string): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`month ${month} out of range`);
  if (isPosixLocale(locale)) return POSIX_MONTHS[month - 1] as string;
  let names = monthNames.get(locale);
  if (!names) {
    const f = new Intl.DateTimeFormat(bcp47(locale), { month: "short", timeZone: "UTC" });
    names = POSIX_MONTHS.map((_, i) => f.format(Date.UTC(2001, i, 15)));
    monthNames.set(locale, names);
  }
  return names[month - 1] as string;
}
