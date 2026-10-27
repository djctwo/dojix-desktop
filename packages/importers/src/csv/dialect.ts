// Delimiter and decimal-comma detection (SPEC §5.1 step 2), layered on the Mac tokenizer.
//
// The Macs are comma-only. The desktop picks the delimiter from the header line: a comma
// whenever the header has one outside quotes (so every file a Mac parses is parsed the same
// way), otherwise a semicolon (with decimal commas) or a tab.

import { macCsvFields } from "../swift/text";

export interface CsvDialect {
  delimiter: "," | ";" | "\t";
  /** Numbers use "," as the decimal separator (semicolon files): "1.234,56" → "1234.56". */
  decimalComma: boolean;
}

export const COMMA_DIALECT: CsvDialect = Object.freeze({ delimiter: ",", decimalComma: false });

function countOutsideQuotes(line: string, ch: string): number {
  let inQuotes = false;
  let n = 0;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ch && !inQuotes) n++;
  }
  return n;
}

/** The dialect a header line uses, or null when it has no delimiter outside quotes (a title line). */
export function detectDialect(headerLine: string): CsvDialect | null {
  if (countOutsideQuotes(headerLine, ",") > 0) return COMMA_DIALECT;
  if (countOutsideQuotes(headerLine, ";") > 0) return { delimiter: ";", decimalComma: true };
  if (countOutsideQuotes(headerLine, "\t") > 0) return { delimiter: "\t", decimalComma: false };
  return null;
}

const DECIMAL_COMMA_NUMBER = /^([+-]?\(?[$€£]?[+-]?)(\d{1,3}(?:\.\d{3})+|\d+),(\d+)(\)?)$/;

/** Rewrites a decimal-comma number to the "." form the Mac parsers expect; other text is unchanged. */
export function normaliseDecimalComma(field: string): string {
  const m = DECIMAL_COMMA_NUMBER.exec(field);
  if (!m) return field;
  return `${m[1]}${(m[2] as string).replace(/\./g, "")}.${m[3]}${m[4]}`;
}

/** One line's fields in `dialect` (the Mac tokenizer, plus decimal-comma rewriting). */
export function splitFields(line: string, dialect: CsvDialect): string[] {
  const fields = macCsvFields(line, dialect.delimiter);
  return dialect.decimalComma ? fields.map(normaliseDecimalComma) : fields;
}
