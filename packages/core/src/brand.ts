// Brand model shared by both apps. Pure data: no DOM, no IPC.

export const BRAND_IDS = ["dojix", "greenwick"] as const;
export type BrandId = (typeof BRAND_IDS)[number];

/** Colour tokens for one brand. Every value is a CSS colour string. */
export interface BrandTokens {
  /** Window background. */
  bgApp: string;
  bgSidebar: string;
  bgContent: string;
  bgCard: string;
  /** Brand accent (Dojix gold, Greenwick teal). */
  accent: string;
  /** Accent at low opacity, for selected rows and badges. */
  accentDim: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
}

export interface InstrumentVocabulary {
  /** "Lots" for forex, "Shares" for stocks. */
  qtyLabel: string;
  /** "pips" for forex, "points" for stocks. */
  moveUnit: string;
  /** "Pair" for forex, "Symbol" for stocks. */
  symbolNoun: string;
}

export type SessionModel = "fx-utc" | "us-equities-et";

export type ScreenId =
  | "journal"
  | "dashboard"
  | "analytics"
  | "edgeReport"
  | "pulse"
  | "browse"
  | "watchlist"
  | "import"
  | "settings";

export interface SidebarItem {
  id: ScreenId;
  label: string;
}

export interface SidebarSection {
  title: string;
  items: SidebarItem[];
}

export interface BrandConfig {
  id: BrandId;
  productName: string;
  /** Reverse-DNS app identifier. Deliberately different from the Mac apps' bundle IDs. */
  identifier: string;
  tagline: string;
  tokens: BrandTokens;
  instrument: InstrumentVocabulary;
  sessionModel: SessionModel;
  sidebar: SidebarSection[];
}

/** Bundle IDs used by the native Mac apps. A desktop build must never reuse them. */
export const MAC_BUNDLE_IDS: readonly string[] = ["com.dojix.app", "com.greenwick.app"];

export function isBrandId(value: unknown): value is BrandId {
  return typeof value === "string" && (BRAND_IDS as readonly string[]).includes(value);
}

/** Parses a build-time brand string; throws on anything unknown so a mis-built app fails loudly. */
export function parseBrandId(value: unknown): BrandId {
  if (isBrandId(value)) return value;
  throw new Error(`Unknown brand ${JSON.stringify(value)}; expected one of ${BRAND_IDS.join(", ")}`);
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const RGBA_COLOUR = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)$/i;
const IDENTIFIER = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

/** Returns a list of problems with a brand config (empty when valid). */
export function validateBrand(brand: BrandConfig): string[] {
  const problems: string[] = [];
  if (!isBrandId(brand.id)) problems.push(`id ${brand.id} is not a known brand`);
  if (brand.productName.trim() === "") problems.push("productName is empty");
  if (!IDENTIFIER.test(brand.identifier)) problems.push(`identifier ${brand.identifier} is not reverse-DNS`);
  if (MAC_BUNDLE_IDS.includes(brand.identifier)) {
    problems.push(`identifier ${brand.identifier} collides with a Mac app`);
  }
  for (const [name, value] of Object.entries(brand.tokens)) {
    if (!HEX_COLOUR.test(value) && !RGBA_COLOUR.test(value)) {
      problems.push(`token ${name} is not a #rrggbb or rgba() colour: ${value}`);
    }
  }
  const screens = brand.sidebar.flatMap((s) => s.items.map((i) => i.id));
  if (!screens.includes("journal")) problems.push("sidebar has no journal screen");
  if (new Set(screens).size !== screens.length) problems.push("sidebar lists a screen twice");
  return problems;
}

/** CSS custom property name for a token, e.g. bgApp -> --bg-app. */
export function tokenVar(name: keyof BrandTokens): string {
  return `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
