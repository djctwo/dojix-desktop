import { useEffect, useRef } from "react";
import type { EChartsType } from "echarts/core";
import { prefersReducedMotion } from "../a11y/motion";
import { readThemeColors } from "../theme/tokens";
import { type ChartOption, initChart } from "./echarts";
import { chartTheme } from "./theme";

export interface EChartProps {
  option: ChartOption;
  /**
   * Required text alternative: what the chart shows and its key takeaway ("Equity curve:
   * +$4,210 over 600 trades, max drawdown $1,120"). The canvas/SVG itself is hidden from
   * screen readers.
   */
  ariaLabel: string;
  height?: number | string | undefined;
  /** SVG (default: crisp, deterministic screenshots) or canvas (very large series). */
  renderer?: "svg" | "canvas" | undefined;
  /** ECharts events ("click", …) → handler. */
  onEvents?: Readonly<Record<string, (params: unknown) => void>> | undefined;
  testId?: string | undefined;
}

/**
 * The one ECharts wrapper: brand theme from the design tokens, resize with the container,
 * animation off under reduced motion, disposed on unmount. Views pass plain options.
 */
export function EChart({ option, ariaLabel, height = 240, renderer = "svg", onEvents, testId }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const instance = initChart(node, chartTheme(readThemeColors(node)), { renderer });
    chart.current = instance;
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, [renderer]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const animate = !prefersReducedMotion();
    instance.setOption({ animation: animate, ...option }, { notMerge: true });
  }, [option, renderer]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !onEvents) return;
    const entries = Object.entries(onEvents);
    for (const [name, handler] of entries) instance.on(name, handler);
    return () => {
      for (const [name, handler] of entries) instance.off(name, handler);
    };
  }, [onEvents, renderer]);

  return (
    <div className="chart" style={{ height }} role="img" aria-label={ariaLabel} data-testid={testId}>
      <div ref={el} className="chart-surface" aria-hidden="true" />
    </div>
  );
}
