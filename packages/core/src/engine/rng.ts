// Seeded randomness (SPEC §3.2 `rng`). The Mac's Monte Carlo and sample-trade generation are
// unseeded; the desktop seeds them so results are reproducible and the seed can be shown
// (PARITY D-05). Only invariants of random outputs are parity-tested.

export interface Rng {
  /** The seed this generator started from (shown in the UI where randomness is visible). */
  readonly seed: number;
  /** Uniform double in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  nextInt(n: number): number;
}

/** mulberry32: small, fast, 32-bit state; good enough for resampling and demo data. */
export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) throw new RangeError(`seed must be finite, got ${seed}`);
  const start = seed >>> 0;
  let state = start;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: start,
    next,
    nextInt(n: number) {
      if (!Number.isInteger(n) || n <= 0) throw new RangeError(`nextInt needs a positive integer, got ${n}`);
      return Math.floor(next() * n);
    },
  };
}

/** Fisher–Yates shuffle into a new array. */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Resample with replacement (bootstrap), `n` draws (default: the input length). */
export function resampled<T>(items: readonly T[], rng: Rng, n = items.length): T[] {
  if (items.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[rng.nextInt(items.length)] as T);
  return out;
}
