// Step 2 of the import pipeline: bytes -> text. Pure, no DOM, no IPC.

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  encoding: TextEncodingName;
  /** True when the input started with a byte-order mark (which is stripped). */
  hadBom: boolean;
  /** Text with CRLF and lone CR normalised to LF. */
  text: string;
}

/** Detects the encoding from a byte-order mark, or returns null when there is none. */
export function sniffBom(bytes: Uint8Array): { encoding: TextEncodingName; length: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: "utf-8", length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf-16be", length: 2 };
  }
  return null;
}

export function normaliseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Decodes a trade file: BOM first, then strict UTF-8, then Windows-1252
 * (the encoding MetaTrader uses for ANSI files on Western Windows).
 */
export function decodeTradeFile(bytes: Uint8Array): DecodedText {
  const bom = sniffBom(bytes);
  if (bom) {
    const body = bytes.subarray(bom.length);
    const text = new TextDecoder(bom.encoding).decode(body);
    return { encoding: bom.encoding, hadBom: true, text: normaliseLineEndings(text) };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { encoding: "utf-8", hadBom: false, text: normaliseLineEndings(text) };
  } catch {
    const text = new TextDecoder("windows-1252").decode(bytes);
    return { encoding: "windows-1252", hadBom: false, text: normaliseLineEndings(text) };
  }
}

/**
 * The Mac apps' own decoding, for `swift` compat: strict UTF-8 (a byte-order mark is kept as
 * U+FEFF, which is why a BOM file's 32-column header is not found on the Mac), otherwise
 * Windows-1252; only CRLF becomes LF (a lone CR stays inside the line). UTF-16 files therefore
 * decode as Windows-1252 text full of NULs and import nothing, as on the Mac.
 */
export function decodeTradeFileMac(bytes: Uint8Array): DecodedText {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { encoding: "utf-8", hadBom: text.startsWith("\uFEFF"), text: text.replace(/\r\n/g, "\n") };
  } catch {
    const text = new TextDecoder("windows-1252").decode(bytes);
    return { encoding: "windows-1252", hadBom: false, text: text.replace(/\r\n/g, "\n") };
  }
}
