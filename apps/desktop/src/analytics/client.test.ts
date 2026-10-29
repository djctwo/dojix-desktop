import { describe, expect, it, vi } from "vitest";
import { createDefaultClient, createWorkerClient } from "./client";
import { AnalyticsEngine } from "./engine";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { TEST_SETTINGS } from "../test-support/render";

/** A Worker stand-in that runs the engine like analytics.worker.ts does. */
class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  private readonly engine = new AnalyticsEngine();
  postMessage(req: WorkerRequest) {
    queueMicrotask(() => {
      let res: WorkerResponse;
      try {
        res =
          req.type === "load"
            ? { type: "loaded", requestId: req.requestId, result: this.engine.load(req.datasetId, req.brand, req.rows) }
            : { type: "ran", requestId: req.requestId, result: this.engine.run(req) };
      } catch (e) {
        res = { type: "failed", requestId: req.requestId, message: (e as Error).message };
      }
      this.onmessage?.({ data: res } as MessageEvent<WorkerResponse>);
    });
  }
  terminate() {
    this.terminated = true;
  }
}

describe("worker client", () => {
  it("pairs requests and responses and surfaces failures", async () => {
    const worker = new FakeWorker();
    const client = createWorkerClient(worker as unknown as Worker);
    expect((await client.load(1, "dojix", [])).count).toBe(0);
    const run = await client.run({ datasetId: 1, now: 0, settings: TEST_SETTINGS, filter: {}, componentIds: [] });
    expect(run.tradeCount).toBe(0);
    await expect(client.run({ datasetId: 2, now: 0, settings: TEST_SETTINGS, filter: {}, placement: "timing" })).rejects.toThrow(/not loaded/);
    worker.onmessage?.({ data: { type: "failed", requestId: 999, message: "stray" } } as MessageEvent<WorkerResponse>);
  });

  it("rejects pending requests when the worker dies or is disposed", async () => {
    const worker = new FakeWorker();
    worker.postMessage = () => undefined;
    const client = createWorkerClient(worker as unknown as Worker);
    const a = client.load(1, "dojix", []);
    worker.onerror?.({ message: "" } as ErrorEvent);
    await expect(a).rejects.toThrow(/worker stopped/);
    const b = client.load(2, "dojix", []);
    client.dispose();
    await expect(b).rejects.toThrow(/was stopped/);
    expect(worker.terminated).toBe(true);
  });

  it("falls back to the in-thread engine without Worker support", async () => {
    expect(typeof Worker).toBe("undefined");
    const client = createDefaultClient();
    expect((await client.load(1, "greenwick", [])).datasetId).toBe(1);
    expect((await client.run({ datasetId: 1, now: 0, settings: TEST_SETTINGS, filter: {}, componentIds: [] })).cards).toEqual([]);
    client.dispose();
  });

  it("creates a module worker when the platform has them", () => {
    const created: unknown[] = [];
    vi.stubGlobal(
      "Worker",
      class {
        constructor(...args: unknown[]) {
          created.push(args);
        }
        postMessage() {}
        terminate() {}
      },
    );
    createDefaultClient();
    expect(created).toHaveLength(1);
    expect((created[0] as unknown[])[1]).toEqual({ type: "module", name: "analytics" });
    vi.unstubAllGlobals();
  });
});
