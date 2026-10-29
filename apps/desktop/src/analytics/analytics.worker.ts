// The analytics Web Worker: the core engine runs here, off the UI thread (SPEC 7.4).
import { errorMessage } from "@dojix-desktop/core";
import { AnalyticsEngine, cloneSafe } from "./engine";
import type { WorkerRequest, WorkerResponse } from "./protocol";

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
const engine = new AnalyticsEngine();

scope.onmessage = (e) => {
  const req = e.data;
  try {
    if (req.type === "load") {
      scope.postMessage({ type: "loaded", requestId: req.requestId, result: engine.load(req.datasetId, req.brand, req.rows) });
      return;
    }
    const result = engine.run(req);
    try {
      scope.postMessage({ type: "ran", requestId: req.requestId, result });
    } catch {
      scope.postMessage({ type: "ran", requestId: req.requestId, result: cloneSafe(result) });
    }
  } catch (err) {
    scope.postMessage({ type: "failed", requestId: req.requestId, message: errorMessage(err) });
  }
};
