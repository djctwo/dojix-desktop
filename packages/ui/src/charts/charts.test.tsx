import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const instance = {
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};
const init = vi.fn((...args: unknown[]) => (args.length > 0 ? instance : instance));
vi.mock("./echarts", () => ({ initChart: (...args: unknown[]) => init(...args) }));

const { EChart } = await import("./EChart");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EChart", () => {
  it("initialises with the brand theme, labels the chart and disposes on unmount", () => {
    const observed: Element[] = [];
    class FakeObserver {
      constructor(private readonly cb: () => void) {}
      observe(el: Element) {
        observed.push(el);
        this.cb();
      }
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const onClick = vi.fn();
    const { unmount, rerender } = render(
      <EChart option={{ series: [{ type: "bar", data: [1, 2] }] }} ariaLabel="P&L by hour" onEvents={{ click: onClick }} testId="c" />,
    );
    const figure = screen.getByRole("img", { name: "P&L by hour" });
    expect(figure.getAttribute("data-testid")).toBe("c");
    expect(figure.style.height).toBe("240px");
    expect(init).toHaveBeenCalledTimes(1);
    const [el, theme, opts] = init.mock.calls[0] as [HTMLElement, { color: string[] }, { renderer: string }];
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(theme.color).toHaveLength(8);
    expect(opts.renderer).toBe("svg");
    expect(observed).toHaveLength(1);
    expect(instance.resize).toHaveBeenCalled();
    expect(instance.setOption).toHaveBeenCalledWith(expect.objectContaining({ animation: true }), { notMerge: true });
    expect(instance.on).toHaveBeenCalledWith("click", onClick);
    rerender(<EChart option={{ series: [] }} ariaLabel="P&L by hour" height={100} />);
    expect(instance.off).toHaveBeenCalledWith("click", onClick);
    unmount();
    expect(instance.dispose).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("turns animation off under reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    render(<EChart option={{}} ariaLabel="x" renderer="canvas" />);
    expect(instance.setOption).toHaveBeenCalledWith(expect.objectContaining({ animation: false }), { notMerge: true });
    expect((init.mock.calls[0] as unknown[])[2]).toEqual({ renderer: "canvas" });
    vi.unstubAllGlobals();
  });
});
