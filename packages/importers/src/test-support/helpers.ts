// Test helpers (excluded from coverage).
import type { BrandId } from "@dojix-desktop/core";
import { importTradeFile, type ImportOptions, type ImportResult } from "../pipeline";
import type { CompatMode } from "../model";

export const NOW = Date.UTC(2026, 9, 27, 12);

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function utf16(s: string, littleEndian: boolean, withBom = true): Uint8Array {
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

export function imp(text: string | Uint8Array, brand: BrandId, compat: CompatMode = "fixed", extra: Partial<ImportOptions> = {}): ImportResult {
  return importTradeFile(typeof text === "string" ? utf8(text) : text, { brand, compat, now: NOW, ...extra });
}

/** Sum of netProfit as numbers (fine for hand-checked fixtures). */
export function totalProfit(r: ImportResult): number {
  return r.trades.reduce((s, t) => s + Number(t.netProfit), 0);
}
