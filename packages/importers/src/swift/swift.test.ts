import { describe, expect, it } from "vitest";
import { SwiftDecimal } from "@dojix-desktop/core";
import { decimalDescription, decimalFromDouble, doubleDescription, swiftDouble, swiftInt, swiftInt64 } from "./numbers";
import { DateParsers, compilePattern, parseDatePattern, parseIso8601 } from "./dates";
import {
  hasGreenwickControls,
  isFoundationControl,
  keepLettersDigitsDots,
  macCsvFields,
  macLines,
  removeGreenwickControls,
  startsWithNumberCharacter,
  stripFoundationControls,
} from "./text";

const NOW = Date.UTC(2026, 9, 27, 12);

describe("swiftDouble (Swift Double(String))", () => {
  it("parses strtod decimal, hex, inf and nan forms", () => {
    expect(swiftDouble("1.25")).toBe(1.25);
    expect(swiftDouble("+5")).toBe(5);
    expect(swiftDouble("-.5")).toBe(-0.5);
    expect(swiftDouble("1.")).toBe(1);
    expect(swiftDouble("1e3")).toBe(1000);
    expect(swiftDouble("1e400")).toBe(Infinity);
    expect(swiftDouble("-1e400")).toBe(-Infinity);
    expect(swiftDouble("inf")).toBe(Infinity);
    expect(swiftDouble("-Infinity")).toBe(-Infinity);
    expect(swiftDouble("nan")).toBeNaN();
    expect(swiftDouble("NaN(123)")).toBeNaN();
    expect(swiftDouble("0x1p3")).toBe(8);
    expect(swiftDouble("0x1.8")).toBe(1.5);
    expect(swiftDouble("-0x10")).toBe(-16);
    expect(swiftDouble("0x.8p1")).toBe(1);
  });

  it("rejects what Swift rejects", () => {
    for (const s of ["", " 1", "1 ", "\t1", "1e", ".", "abc", "1,5", "0b1", "0x", "0xp1", "Infinityx", "++1"]) {
      expect(swiftDouble(s), JSON.stringify(s)).toBeNull();
    }
  });

  it("stops at an embedded NUL like withCString", () => {
    expect(swiftDouble("5\u0000abc")).toBe(5);
    expect(swiftDouble("\u00005")).toBeNull();
  });

  it("rounds long hex mantissas and handles extreme exponents", () => {
    expect(swiftDouble("0x1.00000000000008p0")).toBe(1); // tie → even
    expect(swiftDouble("0x1.00000000000018p0")).toBe(1 + 2 * 2 ** -52);
    expect(swiftDouble("0x1" + "0".repeat(40) + "1p0")).toBe(2 ** 164);
    expect(swiftDouble("0x1p99999999")).toBe(Infinity);
    expect(swiftDouble("0x1p-99999999")).toBe(0);
    expect(swiftDouble("0x1p-1074")).toBe(5e-324);
    expect(swiftDouble("0x000p5")).toBe(0);
  });
});

describe("swiftInt64", () => {
  it("accepts a sign and ASCII digits within 64 bits", () => {
    expect(swiftInt64("123")).toBe(123n);
    expect(swiftInt64("-9223372036854775808")).toBe(-9223372036854775808n);
    expect(swiftInt64("9223372036854775807")).toBe(9223372036854775807n);
    expect(swiftInt64("0009")).toBe(9n);
    expect(swiftInt("+42")).toBe(42);
  });
  it("rejects overflow, spaces and other text", () => {
    for (const s of ["9223372036854775808", "99999999999999999999999", "", "+", " 1", "1.0", "1e3", "١٢"]) expect(swiftInt64(s), s).toBeNull();
    expect(swiftInt("x")).toBeNull();
  });
});

describe("doubleDescription (Swift \\(x))", () => {
  it.each([
    [0, "0.0"],
    [-0, "-0.0"],
    [1, "1.0"],
    [1.5, "1.5"],
    [100, "100.0"],
    [1767225600, "1767225600.0"],
    [1767225600.123, "1767225600.123"],
    [0.1, "0.1"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [1e16, "10000000000000000.0"],
    [2 ** 54, "18014398509481984.0"],
    [1e17, "1e+17"],
    [1.2345678901234568e17, "1.2345678901234568e+17"],
    [5e-324, "5e-324"],
    [-2.5e-7, "-2.5e-07"],
    [NaN, "nan"],
    [Infinity, "inf"],
    [-Infinity, "-inf"],
  ])("%s → %s", (x, s) => {
    expect(doubleDescription(x)).toBe(s);
  });
});

describe("decimalFromDouble (Foundation Decimal(Double))", () => {
  it("is exact for short decimals and noisy for repeating ones", () => {
    expect(decimalFromDouble(0.5)?.toString()).toBe("0.5");
    expect(decimalFromDouble(100)?.toString()).toBe("100");
    expect(decimalFromDouble(-2)?.toString()).toBe("-2");
    expect(decimalFromDouble(0)?.toString()).toBe("0");
    const third = decimalFromDouble(1 / 3)?.toString() ?? "";
    expect(third.startsWith("0.333333333333333")).toBe(true);
    expect(third.length).toBeGreaterThan(18);
    expect(decimalFromDouble(NaN)?.isNaN).toBe(true);
    expect(decimalFromDouble(Infinity)).toBeNull();
    expect(decimalFromDouble(1e-200)?.isNaN === false).toBe(true);
    expect(decimalFromDouble(1e200)).not.toBeNull();
  });
  it("describes decimals in compact form", () => {
    expect(decimalDescription(SwiftDecimal.parse("1.0850") as SwiftDecimal)).toBe("1.085");
    expect(decimalDescription(SwiftDecimal.nan)).toBe("NaN");
  });
});

describe("DateFormatter patterns", () => {
  const utc = (p: string, s: string) => parseDatePattern(s, p, "UTC", NOW);
  it("parses the Mac formats in UTC", () => {
    expect(utc("yyyy.MM.dd HH:mm:ss", "2026.01.15 08:30:00")).toBe(Date.UTC(2026, 0, 15, 8, 30));
    expect(utc("yyyy-MM-dd, HH:mm:ss", "2024-03-15, 10:30:00")).toBe(Date.UTC(2024, 2, 15, 10, 30));
    expect(utc("MM/dd/yyyy HH:mm:ss", "1/5/2024 9:04:05")).toBe(Date.UTC(2024, 0, 5, 9, 4, 5));
    expect(utc("yyyy-MM-dd", "2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(utc("yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00Z")).toBe(Date.UTC(2024, 0, 15, 8, 30));
    expect(utc("yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00-0500")).toBe(Date.UTC(2024, 0, 15, 13, 30));
    expect(utc("yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00+05:30")).toBe(Date.UTC(2024, 0, 15, 3, 0));
    expect(utc("yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00GMT+01:00")).toBe(Date.UTC(2024, 0, 15, 7, 30));
    expect(utc("yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00UTC")).toBe(Date.UTC(2024, 0, 15, 8, 30));
    expect(utc("yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00+05")).toBe(Date.UTC(2024, 0, 15, 3, 30));
    expect(utc("dd/MM/yyyy hh:mm a", "15/01/2024 01:30 PM")).toBe(Date.UTC(2024, 0, 15, 13, 30));
    expect(utc("dd/MM/yyyy hh:mm a", "15/01/2024 12:30 am")).toBe(Date.UTC(2024, 0, 15, 0, 30));
    expect(utc("yyyy-MM-dd HH:mm:ss.SSS", "2024-01-15 08:30:00.5")).toBe(Date.UTC(2024, 0, 15, 8, 30, 0, 500));
    expect(utc("yyyyMMdd", "20240115")).toBe(Date.UTC(2024, 0, 15));
    expect(utc("'at' HH 'o''clock'", "at 08 o'clock")).toBe(Date.UTC(1970, 0, 1, 8));
    expect(utc("a", "PM")).toBe(Date.UTC(1970, 0, 1, 12));
  });

  it("is strict: ranges, literals, whole string", () => {
    for (const [p, s] of [
      ["yyyy-MM-dd", "2024-02-30"],
      ["yyyy-MM-dd", "2023-02-29"],
      ["yyyy-MM-dd", "2024-13-01"],
      ["yyyy-MM-dd", "2024-04-31"],
      ["yyyy-MM-dd HH:mm:ss", "2024-01-01 24:00:00"],
      ["yyyy-MM-dd HH:mm:ss", "2024-01-01 10:60:00"],
      ["yyyy-MM-dd HH:mm:ss", "2024-01-01 10:00:60"],
      ["yyyy-MM-dd", "2024-01-01 10:00"],
      ["yyyy-MM-dd", "2024/01/01"],
      ["yyyy-MM-dd", "0000-01-01"],
      ["yyyy-MM-dd", "-024-01-01"],
      ["hh:mm a", "13:00 PM"],
      ["hh:mm a", "01:00 XM"],
      ["yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00+25:00"],
      ["yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00"],
      ["yyyy-MM-dd'T'HH:mm:ssZ", "2024-01-15T08:30:00*"],
      ["yyyy-MM-dd", "1234567890123-01-01"],
      ["yyyy-MMM-dd", "2024-Jan-01"],
      ["qqq", "x"],
      ["", ""],
    ] as const) {
      expect(utc(p, s), `${p} ${s}`).toBeNull();
    }
    expect(compilePattern("EEE")).toBeNull();
  });

  it("uses ICU's sliding century for two-digit years", () => {
    expect(utc("MM/dd/yy", "03/24/26")).toBe(Date.UTC(2026, 2, 24));
    expect(utc("MM/dd/yy", "03/24/45")).toBe(Date.UTC(2045, 2, 24)); // ≤ 20 years ahead
    expect(utc("MM/dd/yy", "03/24/47")).toBe(Date.UTC(1947, 2, 24)); // start year 1946: 47 > 46
    expect(utc("MM/dd/yy", "12/31/46")).toBe(Date.UTC(1946, 11, 31)); // after the century start
    expect(utc("MM/dd/yy", "01/01/46")).toBe(Date.UTC(2046, 0, 1)); // before it: next century
    expect(utc("MM/dd/yy", "03/24/2026")).toBe(Date.UTC(2026, 2, 24)); // 4 digits read literally
  });

  it("reads exchange time in New York", () => {
    expect(parseDatePattern("03/24/2026 09:30:00", "MM/dd/yyyy HH:mm:ss", "America/New_York", NOW)).toBe(Date.UTC(2026, 2, 24, 13, 30));
    expect(parseDatePattern("01/15/2026 09:30:00", "MM/dd/yyyy HH:mm:ss", "America/New_York", NOW)).toBe(Date.UTC(2026, 0, 15, 14, 30));
    expect(parseDatePattern("01/15/12026 09:30:00", "MM/dd/yyyy HH:mm:ss", "America/New_York", NOW)).toBeNull();
  });

  it("parses ISO 8601 internet date-times", () => {
    expect(parseIso8601("2024-01-15T08:30:00Z", false)).toBe(Date.UTC(2024, 0, 15, 8, 30));
    expect(parseIso8601("2024-01-15T08:30:00.123456Z", true)).toBe(Date.UTC(2024, 0, 15, 8, 30, 0, 123));
    expect(parseIso8601("2024-01-15T08:30:00.1-01:00", true)).toBe(Date.UTC(2024, 0, 15, 9, 30, 0, 100));
    expect(parseIso8601("2024-01-15T08:30:00Z", true)).toBeNull();
    expect(parseIso8601("2024-01-15T08:30:00.5Z", false)).toBeNull();
    expect(parseIso8601("2024-02-30T08:30:00Z", false)).toBeNull();
    expect(parseIso8601("2024-01-15T24:30:00Z", false)).toBeNull();
    expect(parseIso8601("2024-01-15T08:30:00+24:00", false)).toBeNull();
    expect(parseIso8601("2024-01-15 08:30:00Z", false)).toBeNull();
  });

  it("DateParsers tries patterns, then ISO, and honours a length cap", () => {
    const p = new DateParsers(["yyyy.MM.dd HH:mm:ss", "yyyy.MM.dd HH:mm:ss"], "UTC", NOW, 25);
    const trim = (s: string) => s.trim();
    expect(p.parse(" 2026.01.15 08:30:00 ", trim)).toBe(Date.UTC(2026, 0, 15, 8, 30));
    expect(p.parse("2026-01-15T08:30:00.250Z", trim)).toBe(Date.UTC(2026, 0, 15, 8, 30, 0, 250));
    expect(p.parse("", trim)).toBeNull();
    expect(p.parse("2026.01.15 08:30:00" + " ".repeat(10) + "x", trim)).toBeNull();
  });
});

describe("Mac text helpers", () => {
  it("splits lines like the Mac", () => {
    expect(macLines("a\r\nb\n\n  \nc", false)).toEqual(["a", "b", "", "  ", "c"]);
    expect(macLines("a\r\nb\n\n  \nc", true)).toEqual(["a", "b", "c"]);
  });

  it("tokenizes like parseCSVLine (GenericCSVParserTests)", () => {
    expect(macCsvFields("apple,banana,cherry")).toEqual(["apple", "banana", "cherry"]);
    expect(macCsvFields('one,"two, with comma",three')).toEqual(["one", "two, with comma", "three"]);
    expect(macCsvFields("a,,c,")).toEqual(["a", "", "c", ""]);
    expect(macCsvFields(' a , "b""c" ,d')).toEqual(["a", "bc", "d"]);
    expect(macCsvFields('3,"GBPUSD,BUY,0.1')).toEqual(["3", "GBPUSD,BUY,0.1"]);
    expect(macCsvFields("a;b;c", ";")).toEqual(["a", "b", "c"]);
  });

  it("compares whole Characters for non-ASCII lines", () => {
    // A comma followed by a combining acute accent is not a delimiter in Swift.
    expect(macCsvFields("é,x, y ")).toEqual(["é", "x", "y"]);
    expect(macCsvFields("a,́b,c")).toEqual(["a,́b", "c"]);
    expect(macCsvFields('"\u0301x,y"')).toEqual(['"\u0301x', "y"]);
  });

  it("classifies Characters", () => {
    expect(startsWithNumberCharacter("1abc")).toBe(true);
    expect(startsWithNumberCharacter("٣")).toBe(true);
    expect(startsWithNumberCharacter("½")).toBe(true);
    expect(startsWithNumberCharacter("三")).toBe(true);
    expect(startsWithNumberCharacter("abc")).toBe(false);
    expect(startsWithNumberCharacter("")).toBe(false);
    expect(keepLettersDigitsDots("BRK.B-x$1 三")).toBe("BRK.Bx1三");
    expect(isFoundationControl(0x200b)).toBe(true); // Cf
    expect(isFoundationControl(0x41)).toBe(false);
    expect(stripFoundationControls("a\u0007b\nc\td‎", true)).toBe("ab\nc\td");
    expect(stripFoundationControls("a\nb\tc", false)).toBe("abc");
    expect(removeGreenwickControls("a b\u0085c‎d\n", false)).toBe("abc‎d");
    expect(removeGreenwickControls("a\nb\tc", true)).toBe("a\nb\tc");
    expect(hasGreenwickControls("a\nb", true)).toBe(false);
    expect(hasGreenwickControls("a\nb", false)).toBe(true);
  });
});
