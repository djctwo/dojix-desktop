// MonteCarloSimulation (SPEC Appendix A): 1,000 randomised equity paths, percentile bands and
// outcome probabilities.
//
// Port of Dojix `Components/MonteCarloSimulation.swift:32-111` and Greenwick
// `Components/MonteCarloSimulation.swift:32-111`. The brands differ only in how the band
// positions are truncated (`Int(saturating:)` in Dojix, `Int()` in Greenwick); both give
// 49 / 249 / 499 / 749 / 949 for 1,000 simulations.
// - P&Ls ASC by close time; n ≥ 15 (else `result` is nil).
// - Every path starts at 0; band value at index i = the sorted values at i across simulations,
//   read at position Int((sims − 1) × p) for p = .05, .25, .5, .75, .95.
// - target = max(2 × total, 500); DD threshold = .2 × max(total, 1000); a path counts once
//   when peak − value ≥ threshold (the peak starts at 0).
// - median = finals[sims / 2]; worst = finals[Int((sims − 1) × .05)]; best at .95.
//
// **D-05.** The Mac shuffles **without** replacement and is unseeded: every path ends at the
// real total (up to floating-point summation order), so "Hit Target" (≥ 2 × total) is always 0
// and the bands only differ in the middle. `swift` reproduces that with a seeded Fisher–Yates
// shuffle; `fixed` resamples **with** replacement (bootstrap). Both are seeded from
// `ctx.rng.seed` (or `options.seed`), so a given seed always gives the same output, and the
// seed is part of the model so the UI can show it.
//
// Memory: the Mac keeps all 1,000 curves ([sims][n + 1] doubles). The desktop walks the
// simulations in lockstep, one trade index at a time, with one generator per simulation, so
// memory is O(sims) for the bootstrap (plus one permutation per simulation for the swift-mode
// shuffle) and the outputs are the same statistics.

import type { BrandId } from "../brand";
import type { EngineContext } from "../engine/context";
import { defineComponent } from "../engine/registry";
import { createRng, type Rng } from "../engine/rng";
import { sortedByCloseAscending } from "../metrics/metrics-calculator";
import { profitDouble } from "../model/accessors";
import type { Trade } from "../model/trade";
import { swiftMax } from "../swiftcompat/collections";
import { idiv } from "../swiftcompat/int";
import type { ComponentParity } from "./support";

export const MONTE_CARLO_SIMULATIONS = 1000;
const PERCENTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
/** Band labels and opacities (MonteCarloSimulation.swift:67-73); colours are the UI's. */
const BAND_CONFIG: readonly { label: string; opacity: number }[] = [
  { label: "5th", opacity: 0.15 },
  { label: "25th", opacity: 0.2 },
  { label: "Median", opacity: 0.8 },
  { label: "75th", opacity: 0.2 },
  { label: "95th", opacity: 0.15 },
];

export interface PercentileBand {
  label: string;
  /** Cumulative P&L at each trade index 0…n (index 0 = 0). */
  points: number[];
  opacity: number;
}

/** `SimulationResult` (MonteCarloSimulation.swift:14-22). Probabilities are fractions 0–1. */
export interface MonteCarloResult {
  bands: PercentileBand[];
  probProfit: number;
  probTarget: number;
  probDrawdown20: number;
  medianFinalPnL: number;
  worstCase: number;
  bestCase: number;
}

export interface MonteCarloModel {
  /** Null below 15 trades. */
  result: MonteCarloResult | null;
  /** The seed the paths were drawn from (shown in the UI). */
  seed: number;
  /** `shuffle` = the Mac's permutation (swift compat); `bootstrap` = D-05. */
  method: "shuffle" | "bootstrap";
  simulationCount: number;
  tradeCount: number;
  totalPnL: number;
  /** max(2 × total, 500). */
  target: number;
}

export interface MonteCarloOptions {
  /** Defaults to `ctx.rng.seed`. */
  seed?: number;
  /** Defaults to 1,000 (the Mac constant). */
  simulationCount?: number;
}

/** One independent generator per simulation, derived from the seed. */
function simulationRng(seed: number, index: number): Rng {
  return createRng((seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);
}

export function computeMonteCarloSimulation(
  ctx: EngineContext,
  trades: readonly Trade[],
  options: MonteCarloOptions = {},
): MonteCarloModel {
  const seed = (options.seed ?? ctx.rng.seed) >>> 0;
  const sims = options.simulationCount ?? MONTE_CARLO_SIMULATIONS;
  if (!Number.isInteger(sims) || sims < 1) throw new RangeError(`simulationCount must be a positive integer, got ${sims}`);
  const method = ctx.compat === "swift" ? "shuffle" : "bootstrap";
  const pnls = sortedByCloseAscending(trades).map(profitDouble);
  const n = pnls.length;
  let totalPnL = 0;
  for (const p of pnls) totalPnL += p;
  const target = swiftMax(totalPnL * 2, 500);
  const base = { seed, method, simulationCount: sims, tradeCount: n, totalPnL, target } as const;
  if (n < 15) return { result: null, ...base };

  const rngs = Array.from({ length: sims }, (_, s) => simulationRng(seed, s));
  // swift compat: a forward Fisher–Yates per simulation (emits the permutation in order).
  const perms = method === "shuffle" ? Array.from({ length: sims }, () => Float64Array.from(pnls)) : null;
  const cum = new Float64Array(sims);
  const peak = new Float64Array(sims);
  const hitDD = new Uint8Array(sims);
  const ddThreshold = swiftMax(totalPnL, 1000) * 0.2;
  const positions = PERCENTILES.map((p) => Math.trunc((sims - 1) * p));
  const bandData: number[][] = PERCENTILES.map(() => []);
  const column = new Float64Array(sims);

  const recordColumn = () => {
    column.set(cum);
    column.sort();
    for (let k = 0; k < positions.length; k++) (bandData[k] as number[]).push(column[positions[k] as number] as number);
  };
  const checkDrawdown = () => {
    for (let s = 0; s < sims; s++) {
      if (hitDD[s]) continue;
      const v = cum[s] as number;
      peak[s] = swiftMax(peak[s] as number, v);
      if ((peak[s] as number) - v >= ddThreshold) hitDD[s] = 1;
    }
  };

  recordColumn(); // index 0: every path starts at 0
  checkDrawdown();
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < sims; s++) {
      const rng = rngs[s] as Rng;
      let pnl: number;
      if (perms) {
        const a = perms[s] as Float64Array;
        const j = i + rng.nextInt(n - i);
        pnl = a[j] as number;
        a[j] = a[i] as number;
        a[i] = pnl;
      } else {
        pnl = pnls[rng.nextInt(n)] as number;
      }
      cum[s] = (cum[s] as number) + pnl;
    }
    recordColumn();
    checkDrawdown();
  }

  const finals = Float64Array.from(cum).sort();
  let profitable = 0;
  let hitTarget = 0;
  let dd = 0;
  for (let s = 0; s < sims; s++) {
    const f = finals[s] as number;
    if (f > 0) profitable += 1;
    if (f >= target) hitTarget += 1;
    if (hitDD[s]) dd += 1;
  }
  const result: MonteCarloResult = {
    bands: BAND_CONFIG.map((c, k) => ({ label: c.label, points: bandData[k] as number[], opacity: c.opacity })),
    probProfit: profitable / sims,
    probTarget: hitTarget / sims,
    probDrawdown20: dd / sims,
    medianFinalPnL: finals[idiv(sims, 2)] as number,
    worstCase: finals[positions[0] as number] as number,
    bestCase: finals[positions[4] as number] as number,
  };
  return { result, ...base };
}

/**
 * The properties that hold for the Mac's shuffle whatever the random draws (D-05): every final
 * equals the total (up to summation order), so the median, worst and best finals equal it,
 * "Hit Target" is 0 for a positive total, and every band starts at 0 and ends at the total.
 * Returns the violations (empty when the result is consistent). Used to compare a Swift
 * reference `MonteCarloSimulation.result` and the swift-mode port without matching paths.
 */
export function monteCarloShuffleInvariantViolations(result: MonteCarloResult, totalPnL: number): string[] {
  const out: string[] = [];
  // Summation order moves a final by a few ulps of Σ|p|; 1e-6 relative is far above that.
  const tol = 1e-6 * Math.max(1, Math.abs(totalPnL));
  const near = (x: number) => Math.abs(x - totalPnL) <= tol;
  if (!near(result.medianFinalPnL)) out.push("medianFinalPnL");
  if (!near(result.worstCase)) out.push("worstCase");
  if (!near(result.bestCase)) out.push("bestCase");
  if (result.probTarget !== 0) out.push("probTarget"); // target = max(2t, 500) is always above t
  if ((totalPnL > tol && result.probProfit !== 1) || (totalPnL < -tol && result.probProfit !== 0)) out.push("probProfit");
  if (result.bands.length !== 5) out.push("bands");
  for (const b of result.bands) {
    if (b.points[0] !== 0) out.push(`${b.label}.start`);
    const last = b.points[b.points.length - 1];
    if (last === undefined || !near(last)) out.push(`${b.label}.end`);
  }
  return out;
}

export const monteCarloSimulationComponent = defineComponent<BrandId, MonteCarloModel>({
  id: "MonteCarloSimulation",
  brands: ["dojix", "greenwick"],
  tab: "risk",
  minTrades: 15,
  compute: (ctx, trades) => computeMonteCarloSimulation(ctx, trades),
});

/**
 * The only Mac member is `result`, and it is random (unseeded shuffle), so the harness flags it
 * nondeterministic and it is never compared value-for-value (D-05: "only invariants are
 * parity-tested"). No member resolver is registered; `monteCarloShuffleInvariantViolations`
 * checks a reference result's invariants instead.
 */
export const monteCarloSimulationParity: ComponentParity<MonteCarloModel> = {
  component: "MonteCarloSimulation",
  brands: ["dojix", "greenwick"],
  compute: (ctx, trades) => computeMonteCarloSimulation(ctx, trades),
  members: {},
};
