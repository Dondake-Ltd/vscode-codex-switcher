import type { TokenUsage, UsageSnapshot, UsageWindow } from './usage';

export type UsageHistoryRange = 'day' | 'week' | 'month' | 'year';

export type UsageHistorySample = {
  recordedAt: string;
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  totalUsage?: TokenUsage;
  lastUsage?: TokenUsage;
  sourceFile?: string;
};

export type UsagePanelProfile = {
  id: string;
  name: string;
  email: string;
  planType?: string;
  snapshot?: UsageSnapshot;
  history: UsageHistorySample[];
  isStale: boolean;
  isActive: boolean;
  sourceLabel: string;
  refreshStatus?: string;
  updatedLabel: string;
};

export type UsageDashboardEmptyState = {
  kind: 'empty';
  title: string;
  message: string;
};

export type UsageDashboardReadyState = {
  kind: 'ready';
  generatedAt: string;
  activeProfileId: string;
  compareProfileId: string;
  historyRange: UsageHistoryRange;
  profiles: UsagePanelProfile[];
  percentDisplayMode: 'remaining' | 'used';
  percentDisplaySuffixLong: string;
  percentDisplaySuffixCompact: string;
  warningThreshold: number;
  criticalThreshold: number;
};

export type UsageDashboardState = UsageDashboardEmptyState | UsageDashboardReadyState;

export type UsageDashboardToWebviewMessage = {
  type: 'render';
  state: UsageDashboardState;
};

export type UsageDashboardFromWebviewMessage =
  | { type: 'ready' }
  | { type: 'refreshUsage' }
  | { type: 'setCompareProfile'; profileId: string }
  | { type: 'setHistoryRange'; historyRange: UsageHistoryRange }
  | { type: 'switchProfile'; profileId: string };

export type UsageWindowDescriptor = {
  key: 'fiveHour' | 'weekly' | 'other';
  shortLabel: string;
  longLabel: string;
  icon: string;
  window: UsageWindow;
};
