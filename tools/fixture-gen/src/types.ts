export type Brand = "dojix" | "greenwick";

/** Process environment the Swift harness is run under for a fixture. */
export interface Variant {
  /** IANA zone passed as TZ */
  tz: string;
  /** Locale passed as -AppleLocale (drives Calendar.current's first weekday) */
  locale: string;
}

export interface Fixture {
  /** "<brand>/<file name without extension>" — also the reference file name */
  id: string;
  brand: Brand;
  /** F1 … F9 */
  set: string;
  /** Path under golden/fixtures/ */
  path: string;
  /** "file" = go through the brand's import routing; "journal" = stored trades (JSON) */
  kind: "file" | "journal";
  /** Format written (informational; the harness detects formats itself, like the Mac) */
  format: string;
  description: string;
  variants: Variant[];
  /** Run the analytics components (off for the scale sets) */
  components: boolean;
  /** false = generated for the desktop's own tests, never compared with Swift (F8) */
  compare: boolean;
  /** false = generated on demand (F9), not committed */
  committed?: boolean;
  bytes: Uint8Array;
}
