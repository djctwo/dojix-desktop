import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createColumnHelper } from "@tanstack/react-table";
import { DataTable, type DataColumn } from "./DataTable";

afterEach(cleanup);

interface Row {
  id: number;
  symbol: string;
  pnl: number;
}

const h = createColumnHelper<Row>();
const columns: DataColumn<Row>[] = [
  h.accessor("symbol", { header: "Symbol" }),
  h.accessor("pnl", { header: "P&L", meta: { numeric: true, className: "pnl" } }),
  h.display({ id: "note", header: "Note", cell: () => "fictional" }),
];
const rows: Row[] = [
  { id: 1, symbol: "FIXB", pnl: 12.5 },
  { id: 2, symbol: "FIXA", pnl: -3 },
  { id: 3, symbol: "FIXC", pnl: 40 },
];

const cellTexts = (col: number) =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[col]?.textContent);

describe("DataTable", () => {
  it("sorts by header click and sets aria-sort", () => {
    render(<DataTable data={rows} columns={columns} label="Trades" getRowId={(r) => String(r.id)} />);
    expect(screen.getByRole("region", { name: "Trades" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("table", { name: "Trades" }).getAttribute("aria-rowcount")).toBe("4");
    const header = screen.getByRole("columnheader", { name: /Symbol/ });
    expect(header.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(cellTexts(0)).toEqual(["FIXA", "FIXB", "FIXC"]);
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /P&L/ }).className).toBe("num pnl");
    expect(screen.getAllByRole("cell")[1]?.className).toBe("num pnl");
  });

  it("starts from an initial sort and shows the empty row", () => {
    const { rerender } = render(
      <DataTable data={rows} columns={columns} label="Trades" initialSorting={[{ id: "pnl", desc: true }]} />,
    );
    expect(cellTexts(1)).toEqual(["40", "12.5", "-3"]);
    rerender(<DataTable data={[]} columns={columns} label="Trades" empty="No trades match" />);
    expect(screen.getByText("No trades match").getAttribute("colspan")).toBe("3");
    rerender(<DataTable data={[]} columns={columns} label="Trades" />);
    expect(screen.getByText("No rows")).toBeTruthy();
  });

  it("activates rows by click, Enter and arrow keys (roving focus)", async () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable data={rows} columns={columns} label="Trades" onRowActivate={onRowActivate} selectedRowId="0" />,
    );
    const body = screen.getAllByRole("row").slice(1);
    expect(body.map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(body[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(body[1] as HTMLElement);
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[1]);
    const tbody = (body[0] as HTMLElement).parentElement as HTMLElement;
    fireEvent.keyDown(tbody, { key: "End" });
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(document.activeElement).toBe(screen.getAllByRole("row")[3]);
    fireEvent.keyDown(tbody, { key: "Enter" });
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[2]);
    fireEvent.keyDown(tbody, { key: "Home" });
    fireEvent.keyDown(tbody, { key: "ArrowDown" });
    fireEvent.keyDown(tbody, { key: "PageDown" });
    fireEvent.keyDown(tbody, { key: "PageUp" });
    fireEvent.keyDown(tbody, { key: "ArrowUp" });
    fireEvent.keyDown(tbody, { key: " " });
    expect(onRowActivate).toHaveBeenLastCalledWith(rows[0]);
    fireEvent.keyDown(tbody, { key: "x" });
    fireEvent.focus(screen.getAllByRole("row")[2] as HTMLElement);
    expect(screen.getAllByRole("row")[2]?.getAttribute("tabindex")).toBe("0");
  });

  it("virtualises long tables: only a window of rows is in the DOM", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: i, symbol: `S${i}`, pnl: i }));
    // jsdom has no layout: give the scroll area the size the virtualiser reads (clientHeight).
    const ch = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
    const cw = vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
    render(<DataTable data={many} columns={columns} label="Trades" virtualizeAbove={100} onRowActivate={() => undefined} />);
    const rendered = screen.getAllByRole("row").length;
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(200);
    expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe("5001");
    const tbody = screen.getAllByRole("row")[1]?.parentElement as HTMLElement;
    fireEvent.keyDown(tbody, { key: "End" });
    ch.mockRestore();
    cw.mockRestore();
  });

  it("supports controlled sorting, column visibility and order", () => {
    const onSortingChange = vi.fn();
    render(
      <DataTable
        data={rows}
        columns={columns}
        label="Trades"
        sorting={[]}
        onSortingChange={onSortingChange}
        columnVisibility={{ note: false }}
        onColumnVisibilityChange={() => undefined}
        columnOrder={["pnl", "symbol", "note"]}
        onColumnOrderChange={() => undefined}
        testId="t"
      />,
    );
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["P&L", "Symbol"]);
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Symbol/ })).getByRole("button"));
    expect(onSortingChange).toHaveBeenCalled();
  });
});
