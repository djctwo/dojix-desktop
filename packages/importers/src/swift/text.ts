// Swift String behaviour the Mac importers rely on: line splitting, the comma tokenizer
// (which iterates Characters, i.e. grapheme clusters), whitespace trimming and Character
// classification.

import { graphemes, trimSwiftWhitespaces } from "@dojix-desktop/core";

export { trimSwiftWhitespaces as trimWs };

/**
 * The Mac's line split: CRLF → LF, then `split(separator: "\n", omittingEmptySubsequences: false)`.
 * With `dropBlank`, lines that are empty after trimming `.whitespaces` are removed (GenericCSVParser
 * `splitLines`, both apps). Input from `decodeTradeFile` is already LF-only.
 */
export function macLines(content: string, dropBlank: boolean): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return dropBlank ? lines.filter((l) => trimSwiftWhitespaces(l) !== "") : lines;
}

// Fast check: a line made only of these code units has one Character per code unit.
// eslint-disable-next-line no-control-regex -- control characters are single Characters too
const SIMPLE_LINE = /^[\x00-\x7e]*$/;

/**
 * `GenericCSVParser.parseCSVLine` / `CSVParser.parseCSVLine` (both apps, identical): every `"`
 * Character toggles the quote state (so `""` inside quotes yields nothing), a delimiter outside
 * quotes ends the field, and each field is trimmed of `.whitespaces`. Swift compares whole
 * Characters, so a quote or comma followed by a combining mark is ordinary text.
 *
 * `delimiter` is "," on the Mac; the desktop also passes ";" or "\t" (SPEC §5.1 step 2).
 */
export function macCsvFields(line: string, delimiter = ","): string[] {
  const fields: string[] = [];
  let inQuotes = false;
  if (SIMPLE_LINE.test(line)) {
    let current = "";
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        current += line.slice(start, i);
        start = i + 1;
        inQuotes = !inQuotes;
      } else if (c === delimiter && !inQuotes) {
        current += line.slice(start, i);
        fields.push(trimSwiftWhitespaces(current));
        current = "";
        start = i + 1;
      }
    }
    current += line.slice(start);
    fields.push(trimSwiftWhitespaces(current));
    return fields;
  }
  let current = "";
  for (const ch of graphemes(line)) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) {
      fields.push(trimSwiftWhitespaces(current));
      current = "";
    } else current += ch;
  }
  fields.push(trimSwiftWhitespaces(current));
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
