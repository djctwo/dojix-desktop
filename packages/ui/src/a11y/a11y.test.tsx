import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { focusableIn } from "./focus";
import { prefersReducedMotion, useReducedMotion } from "./motion";
import { VisuallyHidden } from "./VisuallyHidden";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a11y helpers", () => {
  it("finds focusable elements, skipping disabled, inert and hidden ones", () => {
    const root = document.createElement("div");
    root.innerHTML = `<button>a</button><button disabled>b</button><a href="#x">c</a><input type="hidden"><div tabindex="0">d</div><div tabindex="-1">e</div><button inert>f</button><button aria-hidden="true">g</button>`;
    expect(focusableIn(root).map((e) => e.textContent)).toEqual(["a", "c", "d"]);
  });

  it("reads and follows the reduced-motion setting", () => {
    expect(prefersReducedMotion()).toBe(false);
    let listener: (() => void) | null = null;
    let matches = false;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, l: () => void) => (listener = l),
      removeEventListener: () => (listener = null),
    }));
    function Probe() {
      return <span data-testid="m">{useReducedMotion() ? "reduce" : "full"}</span>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId("m").textContent).toBe("full");
    matches = true;
    act(() => (listener as unknown as () => void)());
    expect(screen.getByTestId("m").textContent).toBe("reduce");
    unmount();
    expect(listener).toBeNull();
  });

  it("visually hidden text stays in the accessibility tree", () => {
    render(<VisuallyHidden>for screen readers</VisuallyHidden>);
    expect(screen.getByText("for screen readers").className).toBe("visually-hidden");
  });
});
