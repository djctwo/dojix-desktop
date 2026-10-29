import type { BrandId, StoredTrade } from "@dojix-desktop/core";
import type { LoadResult, RunRequest, RunResult, WorkerRequest, WorkerResponse } from "./protocol";

export type RunOptions = Omit<RunRequest, "type" | "requestId">;

/** Runs the analytics engine somewhere: a Web Worker in the app, in-thread in unit tests. */
export interface AnalyticsClient {
  load(datasetId: number, brand: BrandId, rows: readonly StoredTrade[]): Promise<LoadResult>;
  run(options: RunOptions): Promise<RunResult>;
  dispose(): void;
}

/** The engine in a module Web Worker. Requests are answered in order; ids pair them up. */
export function createWorkerClient(worker: Worker): AnalyticsClient {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    if (msg.type === "failed") p.reject(new Error(msg.message));
    else p.resolve(msg.result as never);
  };
  worker.onerror = (e) => {
    const error = new Error(e.message || "The analytics worker stopped.");
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const send = <T>(req: WorkerRequest): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.set(req.requestId, { resolve: resolve as (v: never) => void, reject });
      worker.postMessage(req);
    });
  return {
    load: (datasetId, brand, rows) => send<LoadResult>({ type: "load", requestId: ++seq, datasetId, brand, rows }),
    run: (options) => send<RunResult>({ type: "run", requestId: ++seq, ...options }),
    dispose: () => {
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error("The analytics worker was stopped."));
      pending.clear();
    },
  };
}

/**
 * The app's default: a worker where the platform has them, else the engine in-thread (loaded on
 * first use, so the engine is not in the main bundle when workers exist).
 */
export function createDefaultClient(): AnalyticsClient {
  if (typeof Worker !== "undefined") {
    return createWorkerClient(new Worker(new URL("./analytics.worker.ts", import.meta.url), { type: "module", name: "analytics" }));
  }
  const inline = import("./inline").then((m) => m.createInlineClient());
  return {
    load: async (datasetId, brand, rows) => (await inline).load(datasetId, brand, rows),
    run: async (options) => (await inline).run(options),
    dispose: () => undefined,
  };
}
