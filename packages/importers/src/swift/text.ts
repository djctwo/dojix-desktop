// Swift String behaviour the Mac importers rely on: line splitting, the comma tokenizer
// (which iterates Characters, i.e. grapheme clusters), whitespace trimming and Character
// classification.

import { graphemes } from "@dojix-desktop/core";


/** `CharacterSet.whitespaces`: U+0009 and general category Zs (all in the BMP). */
function isSwiftWhitespace(code: number): boolean {
  return code === 9 || code === 32 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;
}

/**
 * Swift `s.trimmingCharacters(in: .whitespaces)` (tab and Zs; newlines kept). A linear scan:
 * an end-anchored regex like `/[\t\p{Zs}]+$/` backtracks quadratically on long runs of spaces
 * in the middle of hostile input.
 */
export function trimWs(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isSwiftWhitespace(s.charCodeAt(start))) start++;
  while (end > start && isSwiftWhitespace(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/**
 * The Mac's line split: CRLF → LF, then `split(separator: "\n", omittingEmptySubsequences: false)`.
 * With `dropBlank`, lines that are empty after trimming `.whitespaces` are removed (GenericCSVParser
 * `splitLines`, both apps). Input from `decodeTradeFile` is already LF-only.
 */
export function macLines(content: string, dropBlank: boolean): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return dropBlank ? lines.filter((l) => trimWs(l) !== "") : lines;
}

// Grapheme cluster rules that can merge an ASCII quote or delimiter with a neighbour (UAX #29):
// GB9/GB9a: × (Extend | ZWJ | SpacingMark) after it; GB9b: Prepend × before it.
const EXTENDS = /[\p{Grapheme_Extend}\p{Mc}\p{Emoji_Modifier}\u200d]/u;
const PREPEND = new Set([0x600, 0x601, 0x602, 0x603, 0x604, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0xd4e, 0x110bd, 0x110cd, 0x111c2, 0x111c3, 0x1193f, 0x11941, 0x11a3a, 0x11a84, 0x11a85, 0x11a86, 0x11a87, 0x11a88, 0x11a89, 0x11d46, 0x11f02]);

/** True when the ASCII character at `i` is a whole Character (no mark after it, no Prepend before it). */
function standsAlone(line: string, i: number): boolean {
  const next = line.codePointAt(i + 1);
  if (next !== undefined && next >= 0x300 && EXTENDS.test(String.fromCodePoint(next))) return false;
  if (i > 0) {
    let prev = line.charCodeAt(i - 1);
    if (prev >= 0xdc00 && prev <= 0xdfff && i > 1) {
      const high = line.charCodeAt(i - 2);
      if (high >= 0xd800 && high <= 0xdbff) prev = line.codePointAt(i - 2) as number;
    }
    if (PREPEND.has(prev)) return false;
  }
  return true;
}

/**
 * `GenericCSVParser.parseCSVLine` / `CSVParser.parseCSVLine` (both apps, identical): every `"`
 * Character toggles the quote state (so `""` inside quotes yields nothing), a delimiter outside
 * quotes ends the field, and each field is trimmed of `.whitespaces`. Swift compares whole
 * Characters, so a quote or comma followed by a combining mark (or preceded by a Prepend
 * character) is ordinary text. One linear pass over code units; only quotes and delimiters
 * next to non-ASCII text need the grapheme check.
 *
 * `delimiter` is "," on the Mac; the desktop also passes ";" or "\t" (SPEC §5.1 step 2).
 */
export function macCsvFields(line: string, delimiter = ","): string[] {
  const fields: string[] = [];
  let inQuotes = false;
  let current = "";
  let start = 0;
  const d = delimiter.charCodeAt(0);
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 34 && c !== d) continue;
    if (!standsAlone(line, i)) continue;
    if (c === 34) {
      current += line.slice(start, i);
      start = i + 1;
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      current += line.slice(start, i);
      fields.push(trimWs(current));
      current = "";
      start = i + 1;
    }
  }
  current += line.slice(start);
  fields.push(trimWs(current));
  return fields;
}

/** Swift `Character.isNumber` for the first Character of `s` (Unicode Numeric_Type ≠ None; approximated by \p{N}). */
export function startsWithNumberCharacter(s: string): boolean {
  if (s.length === 0) return false;
  const cp = s.codePointAt(0) as number;
  return /\p{N}/u.test(String.fromCodePoint(cp)) || CJK_NUMERALS.has(cp);
}

// Han characters with a numeric value (Unihan kPrimaryNumeric), which Swift counts as numbers.
const CJK_NUMERALS = new Set(
  [..."〇一二三四五六七八九十百千万億兆零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬亿"].map((c) => c.codePointAt(0) as number),
);

/** Swift `Character.isLetter || isNumber || == "."` filter over Characters (Greenwick `cleanSymbol`). */
export function keepLettersDigitsDots(s: string): string {
  let out = "";
  for (const ch of graphemes(s)) {
    const cp = ch.codePointAt(0) as number;
    const first = String.fromCodePoint(cp);
    if (ch === "." || /\p{L}/u.test(first) || /\p{N}/u.test(first) || CJK_NUMERALS.has(cp)) out += ch;
  }
  return out;
}

/** True when a Unicode scalar is in `CharacterSet.controlCharacters` (general categories Cc and Cf). */
export function isFoundationControl(cp: number): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(String.fromCodePoint(cp));
}

/** Removes `CharacterSet.controlCharacters` scalars (Dojix `Trade+Sanitize`), keeping \n and \t when asked. */
export function stripFoundationControls(s: string, keepLineBreaks: boolean): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s; // printable ASCII: nothing to strip
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (keepLineBreaks && (cp === 10 || cp === 9)) out += ch;
    else if (!isFoundationControl(cp)) out += ch;
  }
  return out;
}

/** Greenwick `isDisallowedControl`: general category Cc, plus U+2028 / U+2029. */
export function isGreenwickControl(cp: number, allowLineBreaks: boolean): boolean {
  if (allowLineBreaks && (cp === 10 || cp === 9)) return false;
  return (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) || cp === 0x2028 || cp === 0x2029;
}

/** Greenwick `removingControlCharacters(keepingLineBreaks:)`. */
export function removeGreenwickControls(s: string, keepLineBreaks: boolean): string {
  let out = "";
  for (const ch of s) {
    if (!isGreenwickControl(ch.codePointAt(0) as number, keepLineBreaks)) out += ch;
  }
  return out;
}

/** Greenwick `containsControlCharacters(allowingLineBreaks:)`. */
export function hasGreenwickControls(s: string, allowLineBreaks: boolean): boolean {
  for (const ch of s) if (isGreenwickControl(ch.codePointAt(0) as number, allowLineBreaks)) return true;
  return false;
}
