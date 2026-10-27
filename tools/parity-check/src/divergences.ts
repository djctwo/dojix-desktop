// golden/divergences.yaml: a list of flat maps whose values are JSON scalars, JSON arrays
// or bare text. This reader accepts exactly that subset (no dependency on a YAML library).

export interface Divergence {
  id: string;
  app: "dojix" | "greenwick" | "both";
  headline: boolean;
  approved: boolean;
  reason: string;
  /** Path of the red→green test (Phase 2); null until then */
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
    const need = (k: string): void => {
      if (!(k in it)) throw new Error(`divergence ${id}: missing ${k}`);
    };
    ["id", "app", "headline", "approved", "reason", "test", "affects", "fixtures"].forEach(need);
    if (!Array.isArray(it.affects) || !Array.isArray(it.fixtures)) throw new Error(`divergence ${id}: affects/fixtures must be lists`);
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

/** True when `path` of `fixture` is covered by a divergence entry. */
export function coveredBy(divs: readonly Divergence[], fixture: string, path: string): Divergence | undefined {
  const brand = fixture.split("/")[0];
  return divs.find((d) =>
    (d.app === "both" || d.app === brand)
    && (d.fixtures.length === 0 || d.fixtures.includes(fixture))
    && d.affects.some((a) => a === "*" || path === a || path.startsWith(`${a}.`) || path.startsWith(`${a}[`)
      || (a.endsWith(".*") && path.startsWith(a.slice(0, -1)))));
}

/** Every entry that covers `path` of `fixture`. */
export function coveringIds(divs: readonly Divergence[], fixture: string, path: string): string[] {
  return divs.filter((d) => coveredBy([d], fixture, path)).map((d) => d.id);
}
