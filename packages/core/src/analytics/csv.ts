// CSV text of the analytics exports (KillZone, WhatToCut), SPEC §2.7 / PARITY A3.
//
// Greenwick `Services/Export/AnalyticsCSV.swift:12-16`: every cell that is not a plain number
// goes through `CSVExporter.sanitizeCSVField` (Dojix and Greenwick `CSVExporter.swift:77-92`):
// control characters removed, a leading = + @ - prefixed with ' unless the cell is a number,
// cells with a comma, quote or line break quoted. Dojix's own exports build the same cells
// (its labels never need escaping), so both brands use this.
// The UI writes the text through a Save dialog.

/**
 * Swift `Double(String) != nil`: the whole text is a decimal or hexadecimal float, "inf",
 * "infinity" or "nan" (any case, optional sign). Leading or trailing spaces make it nil.
 */
export function isSwiftDouble(text: string): boolean {
  return /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+\.?[0-9a-fA-F]*|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|inf|infinity|nan)$/i.test(text);
}

/** `CSVExporter.sanitizeCSVField`. */
export function sanitizeCsvField(field: string): string {
  // CharacterSet.controlCharacters = Unicode categories Cc and Cf.
  let value = field.replace(/[\p{Cc}\p{Cf}]/gu, "");
  const first = value[0];
  if (first !== undefined && "=+@-".includes(first) && !isSwiftDouble(value)) value = `'${value}`;
  if (/[,"\n\r]/.test(value)) value = `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** `AnalyticsCSV.content(rows)`: rows joined by "\n", cells by ",". */
export function analyticsCsvContent(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map((cell) => (isSwiftDouble(cell) ? cell : sanitizeCsvField(cell))).join(",")).join("\n");
}
