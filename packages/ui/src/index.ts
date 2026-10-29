// @dojix-desktop/ui: the design system (tokens, fonts, primitives, states, feedback, forms,
// tables, charts, the app shell and the analytics card framework). No IPC, no Tauri: data comes
// in through props. Import "@dojix-desktop/ui/styles.css" once at the app root. See docs/UI.md.

// Theme
export {
  applyBrandTokens,
  pairColorVar,
  pnlTone,
  readThemeColors,
  SEMANTIC_COLORS,
  sessionColorVar,
  type SemanticColor,
  type ThemeColors,
} from "./theme/tokens";
export { composite, contrastRatio, relativeLuminance } from "./theme/contrast";

// Accessibility
export { focusableIn, useFocusTrap } from "./a11y/focus";
export { prefersReducedMotion, useReducedMotion } from "./a11y/motion";
export { VisuallyHidden } from "./a11y/VisuallyHidden";
export { matchesShortcut, parseShortcut, useShortcuts, type ParsedShortcut, type ShortcutBinding } from "./hooks/shortcuts";

// Primitives
export { Button, cx, IconButton, type ButtonProps, type ButtonVariant, type IconButtonProps } from "./primitives/Button";
export { Card, Inset, type CardProps } from "./primitives/Card";
export { Badge, Kbd, type BadgeProps, type BadgeTone } from "./primitives/Badge";
export { HelpTip, type HelpTipProps } from "./primitives/HelpTip";
export { MetricCard, MetricGrid, type MetricCardProps, type MetricTone } from "./primitives/MetricCard";
export {
  PillTabs,
  SegmentedControl,
  TabPanel,
  type PillTabsProps,
  type SegmentedControlProps,
  type TabItem,
} from "./primitives/Tabs";
export { Section, type SectionProps } from "./primitives/Section";
export { SCREEN_ICONS, ScreenIcon } from "./primitives/icons";

// States
export {
  EmptyState,
  ErrorState,
  LoadingState,
  QueryState,
  Skeleton,
  type EmptyStateProps,
  type ErrorStateProps,
  type LoadingStateProps,
  type QueryLike,
  type QueryStateProps,
} from "./states/States";

// Feedback
export { TOAST_MS, ToastProvider, UNDO_MS, useToast, type ToastApi, type ToastKind, type ToastOptions } from "./feedback/Toast";
export { ConfirmDialog, Dialog, type ConfirmDialogProps, type DialogProps } from "./feedback/Dialog";

// Forms
export {
  Checkbox,
  Field,
  Select,
  Switch,
  TextArea,
  TextInput,
  type CheckboxProps,
  type FieldProps,
  type SelectOption,
  type SelectProps,
  type SwitchProps,
} from "./forms/Fields";

// Tables and charts
export { DataTable, type DataColumn, type DataTableProps } from "./table/DataTable";
export { EChart, type EChartProps } from "./charts/EChart";
export type { ChartOption } from "./charts/echarts";
export { chartTheme } from "./charts/theme";

// Shell
export { AppShell, type AppShellProps } from "./shell/AppShell";
export { Screen, type ScreenProps } from "./shell/Screen";

// Analytics card framework
export {
  AnalyticsViewRegistry,
  defineAnalyticsView,
  humanizeComponentId,
  type AnalyticsView,
  type AnalyticsViewProps,
  type CardResult,
} from "./analytics/types";
export {
  AnalyticsCard,
  AnalyticsGrid,
  FallbackView,
  type AnalyticsCardProps,
  type AnalyticsGridItem,
  type AnalyticsGridProps,
} from "./analytics/AnalyticsCard";

// Screens and gates built in earlier phases (security core)
export { JournalScreen, type JournalScreenProps } from "./components/JournalScreen";
export { PlaceholderScreen, type PlaceholderScreenProps } from "./components/PlaceholderScreen";
export { StartupError, type StartupErrorProps } from "./components/StartupError";
export {
  EraseForm,
  LockScreen,
  OlderCopyScreen,
  SaveIssueBanner,
  SetupPasswordScreen,
  UnsavedQuitDialog,
  type EraseFormProps,
  type LockScreenProps,
  type OlderCopyScreenProps,
  type SaveIssueBannerProps,
  type SetupPasswordScreenProps,
  type UnsavedQuitDialogProps,
} from "./components/LockScreens";
export {
  SecuritySettings,
  type SecurityActions,
  type SecuritySettingsProps,
} from "./components/SecuritySettings";
