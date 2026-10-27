// golden/divergences.yaml (PARITY.md §B1): the intentional differences from the Mac apps.
// A list of flat maps whose values are JSON scalars, JSON arrays or bare text; this reader
// accepts exactly that subset (no YAML dependency). It has no imports and uses only erasable
// TypeScript, so tools/parity-check (plain Node) re-exports it.

export interface Divergence {
  id: string;
  app: "dojix" | "greenwick" | "both";
  headline: boolean;
  approved: boolean;
  reason: string;
  /** Path of the red→green test; null until it exists */
  test: string | null;
  /** Reference paths whose values may differ ("outputs.X", "import.parsed", "outputs.*", "*") */
  affects: string[];
  /** Fixture ids the entry applies to ([] = every fixture) */
  fixtures: string[];
}

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (/^(\[|\{|"|-?\d|true$|false$|null$)/.test(v)) {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return v;
}

export function parseDivergences(text: string): Divergence[] {
  const items: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  text.split(/\r?\n/).forEach((line, n) => {
    if (/^\s*(#|$)/.test(line)) return;
    const item = /^- (\w+):\s*(.*)$/.exec(line);
    const field = /^ {2}(\w+):\s*(.*)$/.exec(line);
    if (item) {
      current = {};
      items.push(current);
      current[item[1] ?? ""] = scalar(item[2] ?? "");
    } else if (field && current) {
      current[field[1] ?? ""] = scalar(field[2] ?? "");
    } else {
      throw new Error(`divergences.yaml line ${n + 1}: unsupported syntax`);
    }
  });
  return items.map((it, i) => {
    const id = String(it.id ?? `#${i}`);
    for (const k of ["id", "app", "headline", "approved", "reason", "test", "affects", "fixtures"]) {
      if (!(k in it)) throw new Error(`divergence ${id}: missing ${k}`);
    }
    if (!Array.isArray(it.affects) || !Array.isArray(it.fixtures)) throw new Error(`divergence ${id}: affects/fixtures must be lists`);
    if (!["dojix", "greenwick", "both"].includes(String(it.app))) throw new Error(`divergence ${id}: unknown app ${String(it.app)}`);
    return {
      id,
      app: it.app as Divergence["app"],
      headline: it.headline === true,
      approved: it.approved === true,
      reason: String(it.reason),
      test: typeof it.test === "string" ? it.test : null,
      affects: (it.affects as unknown[]).map(String),
      fixtures: (it.fixtures as unknown[]).map(String),
    };
  });
}

/** True when the entry's `affects` pattern covers the reference path. */
function affectsPath(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern || path.startsWith(`${pattern}.`) || path.startsWith(`${pattern}[`);
}

/**
 * A proposal: not approved and not implemented (`test: null`). It documents a Mac behaviour
 * someone wants to fix and covers no difference until the maintainer approves it.
 */
export function isProposal(d: Divergence): boolean {
  return !d.approved && d.test === null;
}

/**
 * Entries that break the approval rule (PARITY.md B1): a fix that changes a headline number is
 * implemented (has a test) without the maintainer's approval.
 */
export function unapprovedHeadlineFixes(divs: readonly Divergence[]): string[] {
  return divs.filter((d) => d.headline && !d.approved && d.test !== null).map((d) => d.id);
}

/** The first approved entry that covers `path` of `fixture` ("<brand>/<id>"), if any. */
export function coveredBy(divs: readonly Divergence[], fixture: string, path: string): Divergence | undefined {
  const brand = fixture.split("/")[0];
  return divs.find(
    (d) =>
      d.approved &&
      (d.app === "both" || d.app === brand) &&
      (d.fixtures.length === 0 || d.fixtures.includes(fixture)) &&
      d.affects.some((a) => affectsPath(a, path)),
  );
}

/** Every approved entry that covers `path` of `fixture`. */
export function coveringIds(divs: readonly Divergence[], fixture: string, path: string): string[] {
  return divs.filter((d) => coveredBy([d], fixture, path)).map((d) => d.id);
}
