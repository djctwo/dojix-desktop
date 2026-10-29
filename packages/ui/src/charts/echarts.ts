// ECharts, modular: only the chart types and components the analytics cards use are bundled.
// Add a type here when a view needs one (and its *SeriesOption to ChartOption below).

import { BarChart, HeatmapChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import type {
  BarSeriesOption,
  HeatmapSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
  ScatterSeriesOption,
} from "echarts/charts";
import {
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import type {
  DatasetComponentOption,
  GridComponentOption,
  LegendComponentOption,
  MarkAreaComponentOption,
  MarkLineComponentOption,
  TooltipComponentOption,
  VisualMapComponentOption,
} from "echarts/components";
import { type ComposeOption, init, use as registerEcharts } from "echarts/core";
import { CanvasRenderer, SVGRenderer } from "echarts/renderers";

registerEcharts([
  LineChart,
  BarChart,
  ScatterChart,
  HeatmapChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DatasetComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkAreaComponent,
  SVGRenderer,
  CanvasRenderer,
]);

/** Every option a card may pass to `<EChart>`. */
export type ChartOption = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | ScatterSeriesOption
  | HeatmapSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DatasetComponentOption
  | VisualMapComponentOption
  | MarkLineComponentOption
  | MarkAreaComponentOption
>;

export { init as initChart };
