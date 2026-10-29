// Fictional journals for the mock IPC, straight from golden/fixtures (seeded generator; no real
// trades). Loaded as text so the type checker doesn't infer types for 600-row JSON files. A
// mock build references only its own brand's files (the conditions below are build constants),
// so the other brand's fixtures are never bundled; unit tests (mode "test") can load both.

import type { BrandId, StoredTrade } from "@dojix-desktop/core";

export type MockFixture = "f2" | "f1" | "empty";

type Loader = () => Promise<{ default: string }>;
type Loaders = Partial<Record<BrandId, Readonly<Record<Exclude<MockFixture, "empty">, Loader>>>>;

const dojix = {
  f2: () => import("../../../../golden/fixtures/dojix/f2-forex-year-journal.trades.json?raw"),
  f1: () => import("../../../../golden/fixtures/dojix/f1-tiny-journal.trades.json?raw"),
};
const greenwick = {
  f2: () => import("../../../../golden/fixtures/greenwick/f2-stocks-year-journal.trades.json?raw"),
  f1: () => import("../../../../golden/fixtures/greenwick/f1-tiny-journal.trades.json?raw"),
};

const LOADERS: Loaders =
  import.meta.env.MODE === "test"
    ? { dojix, greenwick }
    : import.meta.env.VITE_BRAND === "greenwick"
      ? { greenwick }
      : { dojix };

/** Parses a `*.trades.json` fixture (`{ trades: StoredTrade[] }`). */
export function parseFixture(text: string): StoredTrade[] {
  const parsed = JSON.parse(text) as { trades?: unknown };
  if (!Array.isArray(parsed.trades)) throw new Error("fixture has no trades array");
  return parsed.trades as StoredTrade[];
}

/** The fixture's trades, close time descending (repository order). */
export async function loadFixture(fixture: MockFixture, brand: BrandId): Promise<StoredTrade[]> {
  if (fixture === "empty") return [];
  const loaders = LOADERS[brand];
  if (!loaders) throw new Error(`this build has no ${brand} fixtures`);
  return parseFixture((await loaders[fixture]()).default);
}
