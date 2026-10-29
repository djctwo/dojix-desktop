import {
  asCurrency,
  asPercent,
  asProfitFactor,
  type BrandConfig,
  type PortfolioMetrics,
} from "@dojix-desktop/core";
import { EmptyState, ErrorState, LoadingState, MetricCard, MetricGrid, pnlTone, Screen, Section, SegmentedControl } from "@dojix-desktop/ui";
import { AnalyticsTab } from "../analytics/AnalyticsTab";
import { useAnalyticsEnvironment } from "../analytics/context";
import { useAnalyticsRun } from "../analytics/hooks";
import { useAppCommand } from "../app/commands";
import { useNavigation } from "../app/navigation";
import { useSessionState } from "../app/sessionState";

type Mode = "essential" | "all";

function Headline({ metrics, locale }: { metrics: PortfolioMetrics; locale: string }) {
  return (
    <MetricGrid label="Headline numbers">
      <MetricCard testId="metric-net" label="Net P&L" value={asCurrency(metrics.totalProfit, locale)} tone={pnlTone(metrics.totalProfit)} />
      <MetricCard testId="metric-winrate" label="Win rate" value={asPercent(metrics.winRate)} subtitle={`${metrics.wins}W / ${metrics.losses}L`} />
      <MetricCard testId="metric-pf" label="Profit factor" value={asProfitFactor(metrics.profitFactor)} />
      <MetricCard testId="metric-expectancy" label="Expectancy" value={asCurrency(metrics.expectancy, locale)} tone={pnlTone(metrics.expectancy)} />
      <MetricCard testId="metric-maxdd" label="Max drawdown" value={asCurrency(metrics.maxDrawdown, locale)} />
      <MetricCard testId="metric-trades" label="Trades" value={String(metrics.totalTrades)} />
    </MetricGrid>
  );
}

/**
 * Dashboard skeleton (ui-dashboard builds it out): headline metrics from MetricsCalculator, the
 * Overview cards and the Prop Firm section, all from the registry. Essential/All (Ctrl+Shift+E)
 * is wired; what Essential hides is the dashboard team's call (the Mac's beginner mode).
 */
export function DashboardScreen({ brand }: { brand: BrandConfig }) {
  const { settings } = useAnalyticsEnvironment();
  const { navigate } = useNavigation();
  const [mode, setMode] = useSessionState<Mode>("dashboard.mode", "all");
  useAppCommand("toggleEssential", () => setMode(mode === "all" ? "essential" : "all"));
  const run = useAnalyticsRun({ brand: brand.id, componentIds: [], metrics: true });
  const actions = (
    <SegmentedControl
      label="Analytics shown"
      testId="dashboard-mode"
      value={mode}
      onChange={setMode}
      options={[
        { id: "essential", label: "Essential" },
        { id: "all", label: "All" },
      ]}
    />
  );
  return (
    <Screen title="Dashboard" actions={actions} wide testId="screen-dashboard">
      {run.status === "pending" ? (
        <LoadingState label="Calculating your numbers…" />
      ) : run.status === "error" ? (
        <ErrorState title="The dashboard could not be calculated" error={run.error} onRetry={() => void run.refetch()} />
      ) : run.data.tradeCount === 0 ? (
        <EmptyState
          testId="dashboard-empty"
          title="No trades yet"
          message="Import a file from your broker or platform and your numbers appear here."
          action={{ label: "Import trades", onClick: () => navigate("import") }}
        />
      ) : (
        <>
          {run.data.metrics && <Headline metrics={run.data.metrics} locale={settings.locale} />}
          <Section title="Overview" testId="dashboard-overview">
            <AnalyticsTab brand={brand} placement="overview" label="Overview analytics" />
          </Section>
          {mode === "all" && brand.id === "dojix" && (
            <Section title="Prop firm" collapsible testId="dashboard-propfirm">
              <AnalyticsTab brand={brand} placement="propFirm" label="Prop firm" />
            </Section>
          )}
        </>
      )}
    </Screen>
  );
}
