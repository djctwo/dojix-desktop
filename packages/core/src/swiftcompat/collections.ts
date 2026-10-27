// Swift standard-library collection semantics that JS does not share.

/** Swift's `areInIncreasingOrder` predicate. */
export type Less<T> = (a: T, b: T) => boolean;

/**
 * Swift `Sequence.max(by:)`: on ties the **last** maximum wins, because the stdlib replaces
 * the running result whenever `!areInIncreasingOrder(e, result)`. Returns undefined when empty.
 * (swift/stdlib/public/core/SequenceAlgorithms.swift, `max(by:)`.)
 */
export function maxBy<T>(items: Iterable<T>, less: Less<T>): T | undefined {
  let have = false;
  let result: T | undefined;
  for (const e of items) {
    if (!have) {
      result = e;
      have = true;
    } else if (!less(e, result as T)) {
      result = e;
    }
  }
  return result;
}

/**
 * Swift `Sequence.min(by:)`: on ties the **first** minimum wins (it replaces only when
 * `areInIncreasingOrder(e, result)`). Returns undefined when empty.
 */
export function minBy<T>(items: Iterable<T>, less: Less<T>): T | undefined {
  let have = false;
  let result: T | undefined;
  for (const e of items) {
    if (!have) {
      result = e;
      have = true;
    } else if (less(e, result as T)) {
      result = e;
    }
  }
  return result;
}

const numLess: Less<number> = (a, b) => a < b;

/**
 * Swift `[Double].max()` (`max(by: <)`). NaN behaves as in Swift: a NaN element replaces the
 * running result and the next element replaces the NaN, unlike `Math.max` which returns NaN.
 */
export function seqMax(values: Iterable<number>): number | undefined {
  return maxBy(values, numLess);
}

/** Swift `[Double].min()` (`min(by: <)`); see `seqMax` for NaN. */
export function seqMin(values: Iterable<number>): number | undefined {
  return minBy(values, numLess);
}

/**
 * Swift global `max(x, y)` for Comparable values: returns `y >= x ? y : x`, so ties pick `y`
 * and a NaN `y` is ignored while a NaN `x` is kept. `Math.max` would return NaN either way.
 */
export function swiftMax(x: number, y: number): number {
  return y >= x ? y : x;
}

/** Swift global `min(x, y)`: returns `y < x ? y : x` (ties pick `x`). */
export function swiftMin(x: number, y: number): number {
  return y < x ? y : x;
}

/**
 * Swift `sorted(by:)` as a stable sort (the Swift 5 implementation is stable, and the apps rely
 * on that for ties). Converts the boolean predicate to a comparator the way Swift reads it:
 * `a` before `b` iff `less(a, b)`.
 */
export function stableSorted<T>(items: readonly T[], less: Less<T>): T[] {
  return items
    .map((value, index) => ({ value, index }))
    .sort((a, b) => {
      if (less(a.value, b.value)) return -1;
      if (less(b.value, a.value)) return 1;
      return a.index - b.index;
    })
    .map((x) => x.value);
}

/**
 * `Dictionary(grouping:by:)` with a deterministic order. Swift's dictionary order is random per
 * process, so any output that depends on it is non-deterministic on the Mac. The desktop
 * fixes the order to the first appearance of each key in the input (SPEC §3.1 "Order").
 * Keys compare with SameValueZero (Map semantics).
 */
export function groupByFirstAppearance<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = groups.get(k);
    if (bucket) bucket.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** Sum in iteration order, like `reduce(0, +)` (the order changes the floating-point result). */
export function sumInOrder(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
