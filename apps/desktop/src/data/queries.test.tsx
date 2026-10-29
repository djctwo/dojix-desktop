import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { loadFixture } from "../mock/fixtures";
import { createMockIpc, MOCK_DEFAULT_NOW, MOCK_PASSWORD } from "../mock/mockIpc";
import { IpcProvider, useIpc } from "./IpcContext";
import { createQueryClient, queryKeys, useJournalMutation, useLockTransition, useSetting, useTrades } from "./queries";

afterEach(cleanup);

async function setup(gate: "none" | "locked" = "none") {
  const trades = await loadFixture("f1", "dojix");
  const ipc = createMockIpc({ brand: "dojix", productName: "Dojix", fixture: "f1", gate, now: MOCK_DEFAULT_NOW, latencyMs: 0, fail: [], online: false }, trades);
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <IpcProvider ipc={ipc}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </IpcProvider>
  );
  return { ipc, client, wrapper };
}

describe("queries", () => {
  it("a journal mutation refetches the trades", async () => {
    const { ipc, wrapper } = await setup();
    const { result } = renderHook(() => ({ trades: useTrades(), mutate: useJournalMutation() }), { wrapper });
    await waitFor(() => expect(result.current.trades.data).toHaveLength(5));
    await act(() => result.current.mutate.mutateAsync({ kind: "delete", ids: [5] }));
    await waitFor(() => expect(result.current.trades.data).toHaveLength(4));
    expect(ipc.calls.filter((c) => c === "journal_trades")).toHaveLength(2);
  });

  it("lock transitions replace the cached status", async () => {
    const { client, wrapper } = await setup("locked");
    const { result } = renderHook(() => useLockTransition("lock_unlock"), { wrapper });
    await act(() => result.current.mutateAsync({ password: MOCK_PASSWORD }));
    expect(client.getQueryData<{ phase: string }>(queryKeys.lockStatus)?.phase).toBe("unlocked");
    const now = renderHook(() => useLockTransition("lock_now"), { wrapper });
    await act(() => now.result.current.mutateAsync(undefined as never));
    expect(client.getQueryData<{ phase: string }>(queryKeys.lockStatus)?.phase).toBe("unlocked");
  });

  it("settings fall back to their default", async () => {
    const { ipc, wrapper } = await setup();
    await ipc.call("settings_set", { key: "set", value: 3 });
    const { result } = renderHook(() => ({ a: useSetting("missing", 7), b: useSetting("set", 0) }), { wrapper });
    await waitFor(() => expect(result.current.a.data).toBe(7));
    await waitFor(() => expect(result.current.b.data).toBe(3));
  });

  it("useIpc needs a provider", () => {
    expect(() => renderHook(() => useIpc())).toThrow(/IpcProvider/);
  });
});
