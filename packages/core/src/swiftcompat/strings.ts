// Swift `String` semantics: a String is a sequence of Characters (extended grapheme clusters),
// not UTF-16 code units, so `count`, `prefix(n)` and `suffix(n)` differ from JS `length` and
// `slice` for emoji, flags and combining marks.

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** The Characters of a string, as Swift iterates them. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** Swift `s.count`. */
export function swiftCount(s: string): number {
  let n = 0;
  const it = segmenter.segment(s)[Symbol.iterator]();
  while (!it.next().done) n++;
  return n;
}

/** Swift `String(s.prefix(n))`. */
export function swiftPrefix(s: string, n: number): string {
  return graphemes(s).slice(0, Math.max(0, n)).join("");
}

/** Swift `String(s.suffix(n))`. */
export function swiftSuffix(s: string, n: number): string {
  if (n <= 0) return "";
  return graphemes(s).slice(-n).join("");
}

// CharacterSet.whitespaces = Unicode general category Zs plus CHARACTER TABULATION (U+0009).
// Unlike JS `trim()`, it keeps newlines, U+FEFF and the other line terminators.
const LEADING_WS = /^[\t\p{Zs}]+/u;
const TRAILING_WS = /[\t\p{Zs}]+$/u;

/** Swift `s.trimmingCharacters(in: .whitespaces)`. */
export function trimSwiftWhitespaces(s: string): string {
  return s.replace(LEADING_WS, "").replace(TRAILING_WS, "");
}

/**
 * Swift `s.split(separator: c)` with the default `omittingEmptySubsequences: true`, splitting on
 * whole Characters (a separator followed by a combining mark is a different Character).
 */
export function swiftSplit(s: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const g of graphemes(s)) {
    if (g === separator) {
      if (current !== "") parts.push(current);
      current = "";
    } else {
      current += g;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

/**
 * The Mac `Trade.tagList` (both apps, `Models/Trade.swift`): the comma list split, each tag
 * trimmed of `.whitespaces`, empty tags dropped. Used when reading Mac backups (SPEC §4.4).
 */
export function macTagList(tags: string): string[] {
  return swiftSplit(tags, ",")
    .map(trimSwiftWhitespaces)
    .filter((t) => t !== "");
}
