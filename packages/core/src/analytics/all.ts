// The app's analytics registry: every component of SPEC Appendix A that the engine teams
// registered (E2, E3 and the Greenwick-only E4 set), in their registration order. The UI pairs
// each id with a view and orders the cards within a tab (apps/desktop/src/analytics).

import { AnalyticsRegistry } from "../engine/registry";
import { registerGreenwickOnlyComponents } from "./greenwick/components";
import { registerE2Components } from "./e2";
import { registerE3Components } from "./e3";

/** A new registry holding every analytics component of both brands. */
export function createAnalyticsRegistry(): AnalyticsRegistry {
  const registry = new AnalyticsRegistry();
  registerE2Components(registry);
  registerE3Components(registry);
  registerGreenwickOnlyComponents(registry);
  return registry;
}
