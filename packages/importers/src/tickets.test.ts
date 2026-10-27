import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { SwiftDecimal } from "@dojix-desktop/core";
import { fnv1a64, sha256, toHex } from "./hash";
import { CONTENT_TICKET_BASE, GreenwickTicketCounter, OccurrenceCounter, dojixContentKey, dojixContentTicket, greenwickHash, timeIntervalSince1970 } from "./tickets";

function fnvReference(bytes: Uint8Array): bigint {
  let v = 0xcbf29ce484222325n;
  for (const b of bytes) {
    v ^= BigInt(b);
    v = (v * 0x100000001b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return v;
}

describe("hashes", () => {
  it("SHA-256 matches node:crypto, including padding boundaries", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(toHex(sha256(data)), `length ${n}`).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });

  it("FNV-1a 64 matches a BigInt reference", () => {
    expect(fnv1a64(new Uint8Array())).toBe(0xcbf29ce484222325n);
    expect(fnv1a64(new TextEncoder().encode("a"))).toBe(0xaf63dc4c8601ec8cn); // published test vector
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(fnv1a64(bytes)).toBe(fnvReference(bytes));
        expect(toHex(sha256(bytes))).toBe(createHash("sha256").update(bytes).digest("hex"));
      }),
      { numRuns: 300 },
    );
  });
});

describe("Dojix content tickets (GenericCSVParser.swift:155-168)", () => {
  const trade = {
    symbol: "EURUSD",
    direction: "BUY" as const,
    lots: 0.1,
    openTime: Date.UTC(2026, 1, 2, 9),
    closeTime: Date.UTC(2026, 1, 2, 10),
    openPrice: SwiftDecimal.parse("1.08000") as SwiftDecimal,
    closePrice: SwiftDecimal.parse("1.08200") as SwiftDecimal,
    netProfit: SwiftDecimal.parse("20.00") as SwiftDecimal,
  };

  it("builds the key with %.8f lots, Double epoch seconds and Decimal descriptions", () => {
    expect(dojixContentKey(trade)).toBe("EURUSD|BUY|0.10000000|1770022800.0|1770026400.0|1.08|1.082|20");
  });

  it("maps the first 8 digest bytes into [8e18, 9e18)", () => {
    const key = dojixContentKey(trade);
    const digest = createHash("sha256").update(`${key}#0`).digest();
    const expected = CONTENT_TICKET_BASE + (digest.readBigUInt64BE(0) % 1_000_000_000_000_000_000n);
    expect(dojixContentTicket(key, 0)).toBe(expected);
    expect(dojixContentTicket(key, 1)).not.toBe(expected);
    fc.assert(
      fc.property(fc.string(), fc.nat(), (k, n) => {
        const t = dojixContentTicket(k, n);
        expect(t >= 8_000_000_000_000_000_000n && t < 9_000_000_000_000_000_000n).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("reads timeIntervalSince1970 through the 2001 reference date", () => {
    expect(timeIntervalSince1970(1_767_225_600_000)).toBe(1_767_225_600);
    // Sub-second instants lose precision exactly as a Swift Date does (stored relative to 2001).
    expect(timeIntervalSince1970(123)).toBe(0.123 - 978_307_200 + 978_307_200);
    expect(timeIntervalSince1970(123)).not.toBe(0.123);
  });
});

describe("Greenwick FNV tickets (GenericCSVParser.swift:1044-1061)", () => {
  it("masks to 63 bits, maps 0 to 1 and counts occurrences", () => {
    const h = greenwickHash("Thinkorswim|x");
    expect(h > 0n && h <= 0x7fff_ffff_ffff_ffffn).toBe(true);
    expect(h).toBe(fnvReference(new TextEncoder().encode("Thinkorswim|x")) & 0x7fff_ffff_ffff_ffffn);
    const c = new GreenwickTicketCounter();
    const a = c.ticket("row");
    const b = c.ticket("row");
    expect(a).toBe(greenwickHash("row#0"));
    expect(b).toBe(greenwickHash("row#1"));
    const occ = new OccurrenceCounter();
    expect([occ.next("k"), occ.next("k"), occ.next("j")]).toEqual([0, 1, 0]);
  });
});
