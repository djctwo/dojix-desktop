import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmptyState, ErrorState, LoadingState, QueryState, Skeleton } from "./States";

afterEach(cleanup);

describe("states", () => {
  it("empty state with an action", () => {
    const onClick = vi.fn();
    render(<EmptyState title="No trades yet" message="Import a file." action={{ label: "Import trades", onClick }} testId="e" compact />);
    expect(screen.getByTestId("e").className).toBe("empty empty-compact");
    fireEvent.click(screen.getByRole("button", { name: "Import trades" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("loading is a busy status; error is an alert with retry and the IPC message", () => {
    const onRetry = vi.fn();
    render(
      <>
        <LoadingState label="Opening…" compact />
        <ErrorState error={{ code: "locked", message: "The journal is locked." }} onRetry={onRetry} />
        <Skeleton width={40} />
      </>,
    );
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("The journal is locked.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("QueryState", () => {
  const view = (data: number[]) => <p data-testid="data">{data.length}</p>;

  it("walks pending → error → empty → data", () => {
    const refetch = vi.fn();
    const { rerender } = render(<QueryState query={{ status: "pending", data: undefined, error: null }}>{view}</QueryState>);
    expect(screen.getByRole("status")).toBeTruthy();
    rerender(<QueryState query={{ status: "error", data: undefined, error: new Error("nope"), refetch }} errorTitle="Failed">{view}</QueryState>);
    expect(screen.getByRole("alert").textContent).toContain("nope");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
    rerender(<QueryState query={{ status: "error", data: undefined, error: "x" }}>{view}</QueryState>);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    rerender(<QueryState query={{ status: "success", data: [], error: null }} isEmpty={(d) => d.length === 0}>{view}</QueryState>);
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    rerender(
      <QueryState query={{ status: "success", data: [], error: null }} isEmpty={(d) => d.length === 0} empty={<p>custom empty</p>} loading={<p>wait</p>}>
        {view}
      </QueryState>,
    );
    expect(screen.getByText("custom empty")).toBeTruthy();
    rerender(<QueryState query={{ status: "success", data: [1, 2], error: null }}>{view}</QueryState>);
    expect(screen.getByTestId("data").textContent).toBe("2");
  });
});
