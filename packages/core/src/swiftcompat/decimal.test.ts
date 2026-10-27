import { describe, expect, it } from "vitest";
import { decimalSign, decimalSum, decimalToDouble, SwiftDecimal } from "./decimal";

const parts = (text: string) => {
  const d = SwiftDecimal.parse(text);
  if (d === null) return null;
  const p = d.toParts();
  return p === null ? "nan" : { neg: p.negative, sig: p.significand.toString(), exp: p.exponent };
};

describe("SwiftDecimal.parse (swift-foundation Decimal.__decimal)", () => {
  it("parses plain decimal text", () => {
    expect(parts("12.5")).toEqual({ neg: false, sig: "125", exp: -1 });
    expect(parts("-0.07")).toEqual({ neg: true, sig: "7", exp: -2 });
    expect(parts("100")).toEqual({ neg: false, sig: "100", exp: 0 }); // trailing zeros kept
    expect(parts("1.50")).toEqual({ neg: false, sig: "150", exp: -2 });
    expect(parts("+3")).toEqual({ neg: false, sig: "3", exp: 0 });
    expect(parts("  42  ")).toEqual({ neg: false, sig: "42", exp: 0 });
    expect(parts("007.5")).toEqual({ neg: false, sig: "75", exp: -1 });
    expect(parts(".5")).toEqual({ neg: false, sig: "5", exp: -1 });
  });

  it("reads exponents and limits them", () => {
    expect(parts("1e21")).toEqual({ neg: false, sig: "1", exp: 21 });
    expect(parts("-1E-3")).toEqual({ neg: true, sig: "1", exp: -3 });
    expect(parts("2.5e+2")).toEqual({ neg: false, sig: "25", exp: 1 });
    expect(parts("1e130")).toEqual({ neg: false, sig: "1000", exp: 127 }); // regrown
    expect(parts("1e200")).toBeNull(); // overflow
    expect(parts("1e-200")).toBeNull(); // underflow after rounding to zero
    expect(parts("1e99999")).toBeNull();
    expect(parts("1e-99999")).toBeNull();
  });

  it("keeps the parser's quirks", () => {
    expect(parts("12abc")).toEqual({ neg: false, sig: "12", exp: 0 }); // prefix match
    expect(SwiftDecimal.parse("12abc", { matchEntireString: true })).toBeNull();
    expect(SwiftDecimal.parse("e5")?.isZero).toBe(true); // only "e" consumed: zero, not nil
    expect(parts("abc")).toBeNull();
    expect(parts("")).toBeNull();
    expect(parts("0e1000")).toBeNull(); // compatibility: rejected
    expect(SwiftDecimal.parse("0e5")?.isZero).toBe(true);
    expect(parts("NaN")).toBe("nan");
    expect(parts("-nan")).toBe("nan");
    expect(SwiftDecimal.parse(" nan x", { matchEntireString: true })).toBeNull();
    expect(SwiftDecimal.parse(" nan ", { matchEntireString: true })?.isNaN).toBe(true);
    expect(SwiftDecimal.parse("-0")?.sign()).toBe(0); // no negative zero
  });

  it("rounds digits beyond 128 bits with banker's rounding", () => {
    const big = "340282366920938463463374607431768211455"; // UInt128.max
    expect(parts(big)).toEqual({ neg: false, sig: big, exp: 0 });
    const over = "3402823669209384634633746074317682114559"; // one more digit
    expect(parts(over)).toEqual({ neg: false, sig: "34028236692093846346337460743176821146", exp: 2 });
    expect(parts("123456789012345678901234567890123456789012345")).toEqual({
      neg: false,
      sig: "123456789012345678901234567890123456789",
      exp: 6,
    });
    expect(parts("1.23456789012345678901234567890123456789012345")).toEqual({
      neg: false,
      sig: "123456789012345678901234567890123456789",
      exp: -38,
    });
  });

  it("shrinks below 10^-128 with rounding", () => {
    expect(parts("1.5e-128")).toEqual({ neg: false, sig: "2", exp: -128 });
    expect(parts("2.5e-128")).toEqual({ neg: false, sig: "2", exp: -128 }); // tie → even
    expect(parts("123e-130")).toEqual({ neg: false, sig: "1", exp: -128 });
    expect(parts("125e-130")).toEqual({ neg: false, sig: "1", exp: -128 });
    expect(parts("151e-130")).toEqual({ neg: false, sig: "2", exp: -128 });
  });
});

describe("Decimal → Double", () => {
  it("divides by 10 once per place, like NSDecimalNumber.doubleValue", () => {
    expect(decimalToDouble("0.07")).toBe(0.06999999999999999);
    expect(decimalToDouble("0.07", "nearest")).toBe(0.07);
    expect(decimalToDouble("0.000001")).toBe(0.0000010000000000000002);
    expect(decimalToDouble("12.34567")).toBe(12.34567);
    expect(decimalToDouble("-30")).toBe(-30);
    expect(decimalToDouble("1e21")).toBe(1e21);
    expect(decimalToDouble("0")).toBe(0);
    expect(Object.is(decimalToDouble("-0"), 0)).toBe(true);
    expect(decimalToDouble("nan")).toBeNaN();
    expect(decimalToDouble("garbage")).toBeNaN();
  });

  it("accumulates large significands in 16-bit words", () => {
    // A 30-digit significand: the word-by-word accumulation rounds at each step.
    const text = "123456789012345678901234567890";
    const expected = (() => {
      let s = 123456789012345678901234567890n;
      const words: number[] = [];
      while (s > 0n) {
        words.push(Number(s & 0xffffn));
        s >>= 16n;
      }
      let d = 0;
      for (let i = words.length - 1; i >= 0; i--) d = d * 65536 + (words[i] as number);
      return d;
    })();
    expect(decimalToDouble(text)).toBe(expected);
  });

  it("gives the sign from the decimal, not the double", () => {
    expect(decimalSign("-0.00")).toBe(0);
    expect(decimalSign("-1e-100")).toBe(-1);
    expect(decimalSign("5")).toBe(1);
    expect(decimalSign("x")).toBeNaN();
    expect(SwiftDecimal.nan.sign()).toBeNaN();
  });
});

describe("Decimal arithmetic", () => {
  const d = (t: string) => SwiftDecimal.parse(t) as SwiftDecimal;

  it("adds and subtracts exactly", () => {
    expect(d("0.1").add(d("0.2")).toString()).toBe("0.3");
    expect(d("100").subtract(d("0.01")).toString()).toBe("99.99");
    expect(d("-5").add(d("5")).toString()).toBe("0");
    expect(decimalSum(["0.1", "0.2", "-0.3"]).isZero).toBe(true);
    expect(decimalSum(["1.10", d("2.205")]).toString()).toBe("3.305");
    expect(decimalSum(["1", "x"]).isNaN).toBe(true);
  });

  it("multiplies and compares", () => {
    expect(d("1.5").multiply(d("-20")).toString()).toBe("-30");
    expect(d("1.5").compare(d("1.50"))).toBe(0);
    expect(d("-2").compare(d("1"))).toBe(-1);
    expect(d("2").compare(d("1"))).toBe(1);
    expect(d("2").compare(SwiftDecimal.nan)).toBeNaN();
    expect(SwiftDecimal.nan.add(d("1")).isNaN).toBe(true);
    expect(SwiftDecimal.nan.multiply(d("1")).isNaN).toBe(true);
    expect(SwiftDecimal.nan.negate().isNaN).toBe(true);
    expect(SwiftDecimal.zero.negate().isZero).toBe(true);
  });

  it("rounds results into 128 bits and the exponent range", () => {
    const max = d("340282366920938463463374607431768211455");
    const sum = max.add(max);
    expect(sum.toString()).toBe("680564733841876926926749214863536422910");
    const huge = d("1e127");
    expect(huge.multiply(d("1000")).toString()).toBe("1" + "0".repeat(130));
    expect(huge.multiply(d("1e40")).isNaN).toBe(true);
    const tiny = SwiftDecimal.fromParts(false, 15n, -129);
    expect(tiny.toParts()).toEqual({ negative: false, significand: 2n, exponent: -128 });
    expect(SwiftDecimal.fromParts(false, 1n, -200).isZero).toBe(true);
    expect(SwiftDecimal.fromParts(true, 5n, 130).toParts()).toEqual({ negative: true, significand: 5000n, exponent: 127 });
  });

  it("prints canonical text", () => {
    expect(d("1.50").toString()).toBe("1.5");
    expect(d("-0.0700").toString()).toBe("-0.07");
    expect(d("2.5e2").toString()).toBe("250");
    expect(d("1e-3").toString()).toBe("0.001");
    expect(SwiftDecimal.fromInteger(-12).toString()).toBe("-12");
    expect(SwiftDecimal.fromInteger(7n).toString()).toBe("7");
    expect(SwiftDecimal.nan.toString()).toBe("NaN");
    expect(d("12.5").toDouble("nearest")).toBe(12.5);
  });
});
