import type { AnalyticsClient } from "./client";
import { AnalyticsEngine } from "./engine";

/** The engine on this thread (unit tests, and any environment without Web Workers). */
export function createInlineClient(engine: AnalyticsEngine = new AnalyticsEngine()): AnalyticsClient {
  return {
    load: async (datasetId, brand, rows) => engine.load(datasetId, brand, rows),
    run: async (options) => engine.run(options),
    dispose: () => undefined,
  };
}
