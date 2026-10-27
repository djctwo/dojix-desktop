// Prepares the Swift reference harness for one brand (runs in CI, on the macOS runner).
//
//   node tools/swift-ref/prepare.mjs --brand dojix --src <checkout of djctwo/dojix>
//
// 1. Copies the app's Swift sources (pinned commit) into the harness target, unchanged except:
//    - the `@main` attribute is removed (the harness has its own entry point);
//    - in the computational files (components, analytics, import, models, extensions and the
//      backup format files), member-level `private`/`fileprivate` becomes internal, so the
//      harness can read each component's computed values (SPEC §10.2). Nothing else changes.
// 2. Scans the component files and writes RefGenerated.swift: one accessor per computed value
//    of every analytics component, plus `RefDumpable` conformances that expose the computed
//    properties of the components' result types.
//
// Also usable locally (pure Node, no Swift) to preview what the harness will read.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const BRANDS = {
  dojix: { appDir: "Dojix", target: "DojixRef" },
  greenwick: { appDir: "StockJournal", target: "GreenwickRef" },
};

/** Files whose member-level `private` is opened up (relative to the app dir). */
const OPEN_DIRS = ["Components", "Services/Analytics", "Services/Import", "Models", "Extensions"];
const OPEN_FILES = [
  "Services/Security/BackupEncryption.swift",
  "Services/Security/ExportEncryption.swift",
  "Services/Security/KeyDerivation.swift",
  "Services/Demo/DemoDataGenerator.swift",
];

/** Inputs the generated code can pass to a component, by declared type. */
const INPUTS = {
  "[Trade]": "ctx.trades",
  "MetricsCalculator.PortfolioMetrics": "ctx.metrics",
  "[StrategyCheckpoint]": "ctx.checkpoints",
};

/** Result types never worth encoding (UI values). */
const UI_TYPE = /\bsome\b|\bView\b|\bColor\b|\bFont\b|Gradient|AnyView|\bImage\b|\bText\b|ShapeStyle|NSImage|NSColor|\bBinding\b|\bShape\b|\bPath\b|\bAngle\b|CGSize|EdgeInsets|AttributedString|LocalizedStringKey|\bToastData\b|UnitPoint|Alignment|\bAxis\b/;

/** Members whose body touches the UI, the clipboard, files, preferences or app state. */
const SIDE_EFFECTS = /NSPasteboard|NSSavePanel|NSOpenPanel|NSWorkspace|UserDefaults|AppStorage|appState|Keychain|FileManager|\.write\(|withAnimation|DispatchQueue|Task\s*\{/;

/** Extra instances of components whose numbers depend on a @State setting (declaration order). */
const EXTRA_INSTANCES = {
  PeriodComparison: [["week", "selectedPeriod: .week"], ["quarter", "selectedPeriod: .quarter"]],
  TradeCalendar: [["lastTradeMonth", "selectedMonth: ctx.lastClose"]],
  GrowthProjection: [["months3", "months: 3"], ["months12", "months: 12"]],
  PositionSizer: [["balance25k_risk2", 'accountBalance: "25000", riskPercent: 2.0']],
  PropFirmTracker: [["custom", "accountSize: 50_000, profitTarget: 10.0, maxDailyLoss: 4.0, maxTotalDrawdown: 8.0"]],
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".swift")) out.push(p);
  }
  return out;
}

/** Removes comments and string contents (keeps quotes) so braces can be counted. */
export function stripCode(lines) {
  const out = [];
  let inBlock = false;
  let inMulti = false;
  for (const line of lines) {
    let s = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", i);
        if (end < 0) break;
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (inMulti) {
        const end = line.indexOf('"""', i);
        if (end < 0) break;
        inMulti = false;
        s += '""';
        i = end + 3;
        continue;
      }
      const two = line.slice(i, i + 2);
      if (two === "//") break;
      if (two === "/*") { inBlock = true; i += 2; continue; }
      if (line.slice(i, i + 3) === '"""') { inMulti = true; i += 3; continue; }
      if (line[i] === '"') {
        // Skip a single-line string, including \( … ) interpolations.
        i++;
        let depth = 0;
        while (i < line.length) {
          if (line[i] === "\\" && line[i + 1] === "(") { depth++; i += 2; continue; }
          if (line[i] === "\\") { i += 2; continue; }
          if (depth > 0 && line[i] === "(") depth++;
          else if (depth > 0 && line[i] === ")") depth--;
          else if (depth === 0 && line[i] === '"') break;
          i++;
        }
        s += '""';
        i++;
        continue;
      }
      s += line[i];
      i++;
    }
    out.push(s);
  }
  return out;
}

const ATTRS = String.raw`((?:@[\w.]+(?:\([^)]*\))?\s+)*)`;
const MODS = String.raw`((?:(?:private|fileprivate|internal|public|static|class|nonisolated|override|lazy|final|mutating)\s+)*)`;
const TYPE_DECL = new RegExp(String.raw`^\s*${ATTRS}${MODS}(?:indirect\s+)?(struct|enum|class|actor|extension)\s+([\w.]+)(\s*<[^>]*>)?`);
const VAR_DECL = new RegExp(String.raw`^\s*${ATTRS}${MODS}var\s+(\w+)\s*:\s*([^{=]+?)\s*\{`);
const FUNC_DECL = new RegExp(String.raw`^\s*${ATTRS}${MODS}func\s+(\w+)\s*\(\s*\)\s*->\s*([^{]+?)\s*\{`);
const STORED_DECL = new RegExp(String.raw`^\s*${ATTRS}${MODS}(let|var)\s+(\w+)\s*:\s*([^={]+?)\s*$`);

/**
 * Parses one Swift file into types (with nesting path) and their members.
 * Returns [{ path: ["Outer","Inner"], kind, generic, members: [{name, type, isFunc, isStatic, attrs, body}], stored: [...] }]
 */
export function parseSwift(source) {
  const raw = source.split("\n");
  const code = stripCode(raw);
  const types = [];
  const stack = []; // { kind: "type"|"member"|"block", type?, member? }
  for (let n = 0; n < code.length; n++) {
    const line = code[n];
    const top = stack[stack.length - 1];
    const inTypeBody = !top || top.kind === "type";
    let opener = null;
    if (inTypeBody) {
      const t = TYPE_DECL.exec(line);
      if (t && line.includes("{")) {
        const parent = top?.type;
        const name = t[4];
        const kind = t[3];
        const path = kind === "extension" ? name.split(".") : [...(parent ? parent.path : []), name];
        const type = { path, kind, generic: Boolean(t[5]), line: n + 1, members: [], stored: [] };
        types.push(type);
        opener = { kind: "type", type };
      } else if (top) {
        const v = VAR_DECL.exec(line);
        const f = FUNC_DECL.exec(line);
        const m = v ?? f;
        if (m) {
          const member = {
            name: m[3], type: m[4], isFunc: Boolean(f), attrs: m[1], mods: m[2],
            isStatic: /\b(static|class)\b/.test(m[2]), line: n + 1, body: [raw[n]],
          };
          top.type.members.push(member);
          opener = { kind: "member", member };
        } else {
          const s = STORED_DECL.exec(line);
          if (s && !/\b(static|class)\b/.test(s[2])) {
            top.type.stored.push({ name: s[4], type: s[5].trim(), attrs: s[1], keyword: s[3], line: n + 1 });
          }
        }
      }
    }
    for (const member of stack.filter((e) => e.kind === "member").map((e) => e.member)) member.body.push(raw[n]);
    let first = true;
    for (const ch of line) {
      if (ch === "{") {
        stack.push(first && opener ? opener : { kind: "block" });
        first = false;
      } else if (ch === "}") {
        stack.pop();
      }
    }
  }
  return types;
}

/** Makes member-level `private`/`fileprivate` internal; top-level private types too (not extensions). */
export function openAccess(source) {
  return source
    .split("\n")
    .map((line) => {
      if (/^\s+/.test(line)) {
        return line.replace(/^(\s+(?:@[\w.]+(?:\([^)]*\))?\s+)*)(?:private|fileprivate)\s+(?!\()/, "$1");
      }
      return line.replace(/^(?:private|fileprivate)\s+((?:final\s+)?(?:struct|enum|class)\s)/, "$1");
    })
    .join("\n");
}

const typeName = (path) => path.join(".");

export function generate(brand, appRoot) {
  const compDir = join(appRoot, "Components");
  const files = readdirSync(compDir).filter((f) => f.endsWith(".swift")).sort();
  const blocks = [];
  const dumpables = [];
  const report = { components: [], skippedComponents: [], skippedMembers: [] };
  const allTypes = new Map();

  for (const file of files) {
    const types = parseSwift(readFileSync(join(compDir, file), "utf8"));
    for (const t of types) {
      const key = typeName(t.path);
      if (!allTypes.has(key)) allTypes.set(key, { ...t, members: [...t.members], stored: [...t.stored], file });
      else allTypes.get(key).members.push(...t.members);
    }
  }

  const usable = (m, owner) => {
    if (m.isStatic) return "static";
    if (m.name === "body" || m.name === "id") return "ui";
    if (/@ViewBuilder/.test(m.attrs)) return "view builder";
    if (UI_TYPE.test(m.type)) return "UI type";
    if (/\b(throws|async)\b/.test(m.type)) return "throws/async";
    if (m.type.trim() === "Void" || m.type.trim() === "()") return "void";
    const bodyText = m.body.join("\n");
    if (/\b(didSet|willSet|set)\s*\{/.test(bodyText)) return "stored with observers / setter";
    if (SIDE_EFFECTS.test(bodyText)) return `side effects (${owner})`;
    return null;
  };

  for (const [name, t] of allTypes) {
    if (t.path.length !== 1 || t.kind !== "struct") continue;
    const decl = readFileSync(join(compDir, t.file), "utf8").split("\n")[t.line - 1] ?? "";
    if (!/:\s*[^{]*\bView\b/.test(decl)) continue;
    // Constructor arguments: stored properties without a default, in declaration order.
    const args = [];
    let ok = true;
    for (const s of t.stored) {
      if (/@(State|Environment|AppStorage|FocusState|Namespace|StateObject|ObservedObject|GestureState)/.test(s.attrs)) continue;
      if (/@Binding/.test(s.attrs)) { ok = false; break; }
      if (s.type.endsWith("?") && s.keyword === "var") continue; // optional var: defaults to nil
      const value = INPUTS[s.type];
      if (!value) { ok = false; break; }
      args.push(`${s.name}: ${value}`);
    }
    if (!ok || args.length === 0) {
      report.skippedComponents.push({ component: name, file: t.file, reason: "inputs are not trades/metrics/checkpoints" });
      continue;
    }
    const members = [];
    for (const m of t.members) {
      const why = usable(m, name);
      if (why) {
        if (why !== "ui" && why !== "UI type" && why !== "view builder" && why !== "void") {
          report.skippedMembers.push({ member: `${name}.${m.name}`, reason: why });
        }
        continue;
      }
      members.push(m);
    }
    if (members.length === 0) {
      report.skippedComponents.push({ component: name, file: t.file, reason: "no computed values" });
      continue;
    }
    report.components.push({ component: name, file: t.file, values: members.map((m) => m.name) });
    const instances = [["", args.join(", ")]];
    for (const [suffix, extra] of EXTRA_INSTANCES[name] ?? []) instances.push([suffix, `${args.join(", ")}, ${extra}`]);
    for (const [suffix, call] of instances) {
      const prefix = suffix ? `${name}[${suffix}]` : name;
      const lines = members.map((m) =>
        `        out.append(RefOutput("${prefix}.${m.name}") { c.${m.name}${m.isFunc ? "()" : ""} })`);
      blocks.push(`    do { // ${t.file}:${t.line}\n        let c = ${name}(${call})\n${lines.join("\n")}\n    }`);
    }
  }

  // Result types: expose their computed properties through RefDumpable.
  for (const [name, t] of allTypes) {
    if (t.kind === "extension" || t.generic) continue;
    if (t.path.length === 1) {
      const decl = readFileSync(join(compDir, t.file), "utf8").split("\n")[t.line - 1] ?? "";
      if (/:\s*[^{]*\bView\b/.test(decl)) continue;
    }
    if (t.kind === "class") continue;
    // Skip types nested inside generic types.
    const parent = t.path.slice(0, -1).join(".");
    if (parent && allTypes.get(parent)?.generic) continue;
    const members = t.members.filter((m) => !usable(m, name));
    if (members.length === 0) continue;
    const pairs = members.map((m) => `("${m.name}", ${m.name}${m.isFunc ? "()" : ""} as Any)`);
    dumpables.push(`extension ${name}: RefDumpable {\n    var refExtras: [(String, Any)] { [${pairs.join(", ")}] }\n}`);
  }

  // Computed properties of Trade and Date (models, extensions, analytics helpers).
  const extrasOf = (typePath) => {
    const found = [];
    for (const dir of ["Models", "Extensions", "Services/Analytics"]) {
      const d = join(appRoot, dir);
      for (const f of readdirSync(d).filter((x) => x.endsWith(".swift")).sort()) {
        for (const t of parseSwift(readFileSync(join(d, f), "utf8"))) {
          if (typeName(t.path) !== typePath) continue;
          for (const m of t.members) {
            const why = usable(m, typePath) ?? (/^Trade\??$/.test(m.type.trim()) ? "returns a Trade" : null);
            if (!why && !found.some((x) => x.name === m.name)) found.push(m);
          }
        }
      }
    }
    return found;
  };
  const tradeExtras = extrasOf("Trade");
  const dateExtras = extrasOf("Date");
  report.tradeExtras = tradeExtras.map((m) => m.name);
  report.dateExtras = dateExtras.map((m) => m.name);
  const pairList = (v, ms) => ms.map((m) => `("${m.name}", ${v}.${m.name}${m.isFunc ? "()" : ""} as Any)`).join(",\n        ");

  const swift = [
    `// GENERATED by tools/swift-ref/prepare.mjs for ${brand}. Do not edit.`,
    "// Reads every computed value of every analytics component (see SPEC §10.2).",
    "import Foundation",
    "import SwiftUI",
    "",
    "@MainActor",
    "func refComponentOutputs(_ ctx: RefContext) -> [RefOutput] {",
    "    var out: [RefOutput] = []",
    ...blocks,
    "    return out",
    "}",
    "",
    "/// Every computed property of `Trade` (per-trade derived values).",
    "@MainActor",
    "func refTradeExtras(_ t: Trade) -> [(String, Any)] {",
    `    [\n        ${pairList("t", tradeExtras)}\n    ]`,
    "}",
    "",
    "/// Every computed property the app adds to `Date` (sessions, hours, day names).",
    "@MainActor",
    "func refDateExtras(_ d: Date) -> [(String, Any)] {",
    `    [\n        ${pairList("d", dateExtras)}\n    ]`,
    "}",
    "",
    ...dumpables,
    "",
  ].join("\n");
  return { swift, report };
}

function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const brand = arg("--brand");
  const src = arg("--src");
  if (!BRANDS[brand] || !src) {
    console.error("usage: prepare.mjs --brand dojix|greenwick --src <app checkout> [--out <dir>] [--dry-run]");
    return 2;
  }
  const { appDir, target } = BRANDS[brand];
  const appRoot = resolve(src, appDir);
  const outDir = resolve(arg("--out", join(here, brand, "Sources", target)));
  const appOut = join(outDir, "App");
  const dryRun = argv.includes("--dry-run");

  const files = walk(appRoot);
  if (!dryRun) {
    rmSync(appOut, { recursive: true, force: true });
    mkdirSync(appOut, { recursive: true });
    cpSync(join(here, "shared"), outDir, { recursive: true });
  }
  let opened = 0;
  for (const f of files) {
    const rel = relative(appRoot, f);
    let text = readFileSync(f, "utf8");
    text = text.replace(/^@main\s*$/m, "// @main removed by tools/swift-ref (the harness has its own entry point)");
    if (OPEN_DIRS.some((d) => rel.startsWith(`${d}/`)) || OPEN_FILES.includes(rel)) {
      const next = openAccess(text);
      if (next !== text) opened++;
      text = next;
    }
    if (!dryRun) {
      const dest = join(appOut, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
    }
  }
  const sourceRoot = dryRun ? appRoot : join(appOut);
  const { swift, report } = generate(brand, sourceRoot);
  if (!dryRun) {
    writeFileSync(join(outDir, "RefGenerated.swift"), swift);
    writeFileSync(join(outDir, "..", "..", "generated-report.json"), JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(argv.includes("--print-swift") ? swift : JSON.stringify(report, null, 2) + "\n");
  }
  console.error(`${brand}: ${files.length} Swift files, ${opened} opened, ${report.components.length} components, ` +
    `${report.components.reduce((n, c) => n + c.values.length, 0)} values, ${report.skippedComponents.length} components skipped, ` +
    `${report.skippedMembers.length} members skipped`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
