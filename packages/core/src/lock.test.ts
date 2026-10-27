import { describe, expect, it } from "vitest";
import { errorCode, errorMessage, idleLabel, IDLE_CHOICES, passwordProblem } from "./lock";

describe("password rule (same as the shell)", () => {
  it("needs 8–128 characters, confirmed", () => {
    expect(passwordProblem("", "")).toMatch(/empty/);
    expect(passwordProblem("12345678", "12345679")).toMatch(/do not match/);
    expect(passwordProblem("1234567", "1234567")).toMatch(/at least 8/);
    expect(passwordProblem("12345678", "12345678")).toBeNull();
    const max = "x".repeat(128);
    expect(passwordProblem(max, max)).toBeNull();
    const over = "x".repeat(129);
    expect(passwordProblem(over, over)).toMatch(/at most 128/);
  });

  it("counts Unicode scalars, not UTF-16 units", () => {
    // 128 astral characters are 256 UTF-16 units but 128 scalars: allowed, as in Rust.
    const astral = "\u{1F512}".repeat(128);
    expect(passwordProblem(astral, astral)).toBeNull();
    const short = "\u{1F512}".repeat(7);
    expect(passwordProblem(short, short)).toMatch(/at least 8/);
  });
});

describe("helpers", () => {
  it("reads shell errors and plain errors", () => {
    expect(errorMessage({ code: "busy", message: "Try again." })).toBe("Try again.");
    expect(errorCode({ code: "busy", message: "Try again." })).toBe("busy");
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorCode(new Error("boom"))).toBeNull();
    expect(errorMessage("text")).toBe("text");
  });

  it("labels the idle choices with Off and a 15-minute default among them", () => {
    expect(IDLE_CHOICES).toContain(15);
    expect(IDLE_CHOICES.map(idleLabel)).toEqual([
      "Off",
      "1 minute",
      "5 minutes",
      "15 minutes",
      "30 minutes",
      "60 minutes",
    ]);
  });
});
