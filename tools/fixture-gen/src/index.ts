export type { Brand, Fixture, Variant } from "./types.ts";
import { dojixFixtures, dojixScale } from "./sets-dojix.ts";
import { greenwickFixtures, greenwickScale } from "./sets-greenwick.ts";
import type { Fixture } from "./types.ts";

/** Every committed fixture, in a stable order. */
export function allFixtures(): Fixture[] {
  return [...dojixFixtures(), ...greenwickFixtures()];
}

/** F9 scale sets (generated on demand; never committed). */
export function scaleFixtures(): Fixture[] {
  return [10_000, 50_000, 100_000].flatMap((n) => [dojixScale(n), greenwickScale(n)]);
}
