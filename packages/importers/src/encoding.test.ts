import { describe, expect, it } from "vitest";
import { decodeTradeFile, normaliseLineEndings, sniffBom } from "./index";

const ascii = (s: string) => new TextEncoder().encode(s);

function utf16(s: string, littleEndian: boolean, withBom: boolean): Uint8Array {
  const out = new Uint8Array((s.length + (withBom ? 1 : 0)) * 2);
  const view = new DataView(out.buffer);
  let offset = 0;
  if (withBom) {
    view.setUint16(0, 0xfeff, littleEndian);
    offset = 2;
  }
  for (let i = 0; i < s.length; i++) view.setUint16(offset + i * 2, s.charCodeAt(i), littleEndian);
  return out;
}

describe("sniffBom", () => {
  it("finds UTF-8, UTF-16LE and UTF-16BE marks", () => {
    expect(sniffBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toEqual({ encoding: "utf-8", length: 3 });
    expect(sniffBom(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual({ encoding: "utf-16le", length: 2 });
    expect(sniffBom(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toEqual({ encoding: "utf-16be", length: 2 });
  });

  it("returns null without a mark, including for empty input", () => {
    expect(sniffBom(ascii("Ticket,Symbol"))).toBeNull();
    expect(sniffBom(new Uint8Array())).toBeNull();
  });
});

describe("decodeTradeFile", () => {
  it("decodes UTF-16LE with a BOM and strips the BOM", () => {
    const decoded = decodeTradeFile(utf16("Ticket,Symbol\r\n1,EURUSD\r\n", true, true));
    expect(decoded).toEqual({ encoding: "utf-16le", hadBom: true, text: "Ticket,Symbol\n1,EURUSD\n" });
  });

  it("decodes UTF-16BE with a BOM", () => {
    expect(decodeTradeFile(utf16("A,B", false, true)).text).toBe("A,B");
  });

  it("keeps valid UTF-8 as UTF-8", () => {
    const decoded = decodeTradeFile(ascii("Symbol,Note\nEURUSD,café\n"));
    expect(decoded.encoding).toBe("utf-8");
    expect(decoded.text).toContain("café");
  });

  it("falls back to Windows-1252 for invalid UTF-8 (euro and pound signs)", () => {
    const decoded = decodeTradeFile(new Uint8Array([0x80, 0x31, 0x30, 0x2c, 0xa3, 0x35]));
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.text).toBe("€10,£5");
  });
});

describe("normaliseLineEndings", () => {
  it("turns CRLF and lone CR into LF", () => {
    expect(normaliseLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});
