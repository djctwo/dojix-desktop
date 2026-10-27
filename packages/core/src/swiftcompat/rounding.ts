// Swift `FloatingPointRoundingRule` behaviour. `Math.round` is *not* any of these: it rounds
// halves toward +∞, so Math.round(-2.5) === -2 where Swift's `(-2.5).rounded()` is -3.

export type SwiftRoundingRule =
  | "toNearestOrAwayFromZero" // `.rounded()` default (schoolbook)
  | "toNearestOrEven"
  | "up"
  | "down"
  | "towardZero"
  | "awayFromZero";

function nearestAway(x: number): number {
  const t = Math.trunc(x);
  // x - t is exact for every finite double (it only drops the integer part).
  const frac = Math.abs(x - t);
  if (frac >= 0.5) return t + Math.sign(x);
  return t;
}

function nearestEven(x: number): number {
  const t = Math.trunc(x);
  const frac = Math.abs(x - t);
  if (frac > 0.5) return t + Math.sign(x);
  if (frac < 0.5) return t;
  return t % 2 === 0 ? t : t + Math.sign(x);
}

/**
 * Swift `x.rounded(rule)`; the default rule is `.toNearestOrAwayFromZero`, which is what
 * PositionSizer uses (`(lots * 100).rounded() / 100`, Dojix `Components/PositionSizer.swift:35`,
 * Greenwick `Components/PositionSizer.swift:34`). NaN and ±∞ pass through; -0 is preserved.
 */
export function swiftRounded(x: number, rule: SwiftRoundingRule = "toNearestOrAwayFromZero"): number {
  if (!Number.isFinite(x)) return x;
  let r: number;
  switch (rule) {
    case "toNearestOrAwayFromZero":
      r = nearestAway(x);
      break;
    case "toNearestOrEven":
      r = nearestEven(x);
      break;
    case "up":
      r = Math.ceil(x);
      break;
    case "down":
      r = Math.floor(x);
      break;
    case "towardZero":
      r = Math.trunc(x);
      break;
    case "awayFromZero":
      r = x < 0 ? Math.floor(x) : Math.ceil(x);
      break;
  }
  // Keep the sign of zero the way Swift does (e.g. (-0.4).rounded() is -0.0).
  return r === 0 ? (Object.is(x, -0) || x < 0 ? -0 : 0) : r;
}
