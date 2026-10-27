// Text → bytes for fixture files.

export type Encoding = "utf8" | "utf8-bom" | "utf16le-bom" | "utf16le" | "cp1252";

// Windows-1252 bytes 0x80–0x9F that differ from Latin-1.
const CP1252_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88,
  "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93,
  "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

export function encodeText(text: string, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return new TextEncoder().encode(text);
    case "utf8-bom":
      return concat(new Uint8Array([0xef, 0xbb, 0xbf]), new TextEncoder().encode(text));
    case "utf16le":
    case "utf16le-bom": {
      const bom = encoding === "utf16le-bom" ? 2 : 0;
      const out = new Uint8Array(bom + text.length * 2);
      if (bom) {
        out[0] = 0xff;
        out[1] = 0xfe;
      }
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[bom + i * 2] = c & 0xff;
        out[bom + i * 2 + 1] = c >>> 8;
      }
      return out;
    }
    case "cp1252": {
      const out: number[] = [];
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        const extra = CP1252_EXTRA[ch];
        if (extra !== undefined) out.push(extra);
        else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out.push(code);
        else throw new Error(`not representable in Windows-1252: ${ch}`);
      }
      return new Uint8Array(out);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");

/** CSV field: quoted when it holds a comma, quote or line break (quotes doubled). */
export function q(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const row = (fields: readonly (string | number)[]): string => fields.map((f) => q(String(f))).join(",");
