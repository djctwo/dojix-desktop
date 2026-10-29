import { describe, expect, it } from "vitest";

// The app runs with Tauri's `freezePrototype`: Object.prototype is frozen before any script, so
// a library that assigns an inherited property such as `constructor` on a plain object throws.
// This file (its own module graph) freezes it first, then loads and draws every chart type and
// component the app registers. ECharts needs patches/echarts@6.1.0.patch for this.
Object.freeze(Object.prototype);

describe("charts under a frozen Object.prototype", () => {
  it("load and draw every registered series and component", async () => {
    const { initChart } = await import("./echarts");
    const el = document.createElement("div");
    document.body.append(el);
    const chart = initChart(el, undefined, { renderer: "svg", width: 400, height: 300 });
    chart.setOption({
      animation: false,
      dataset: { source: [["a", 1], ["b", -2]] },
      legend: {},
      tooltip: { trigger: "axis" },
      grid: {},
      xAxis: { type: "category", data: ["a", "b"] },
      yAxis: { type: "value" },
      series: [
        { type: "bar", data: [1, -2], markLine: { data: [{ yAxis: 0 }] } },
        { type: "line", data: [1, 2], markArea: { data: [[{ xAxis: "a" }, { xAxis: "b" }]] } },
        { type: "scatter", data: [[0, 1]] },
      ],
    });
    chart.setOption(
      {
        xAxis: { type: "category", data: ["Mon"] },
        yAxis: { type: "category", data: ["9"] },
        visualMap: { min: 0, max: 2, show: false },
        series: [{ type: "heatmap", data: [[0, 0, 1]] }],
      },
      { notMerge: true },
    );
    chart.setOption({ series: [{ type: "pie", data: [{ value: 1, name: "x" }] }] }, { notMerge: true });
    expect(el.querySelector("svg")).not.toBeNull();
    chart.dispose();
    expect(Object.isFrozen(Object.prototype)).toBe(true);
  });

  it("the shell's libraries load too (React, TanStack Table and Virtual, Lucide)", async () => {
    await import("react-dom/client");
    await import("@tanstack/react-table");
    await import("@tanstack/react-virtual");
    await import("lucide-react");
    await import("../index");
  });
});
