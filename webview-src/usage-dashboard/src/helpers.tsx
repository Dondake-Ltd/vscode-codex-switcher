import { h } from 'preact';
import type { ComponentChildren } from 'preact';
import type {
  UsageDashboardReadyState,
  UsageDashboardState,
  UsageHistoryRange,
  UsageHistorySample,
  UsagePanelProfile,
  UsageWindowDescriptor
} from '../../../src/usageDashboardTypes';
import type { TokenUsage, UsageSnapshot, UsageWindow } from '../../../src/usage';

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export function parseIsoMs(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function formatTimestamp(value: string): string {
  const parsed = parseIsoMs(value);
  if (!Number.isFinite(parsed)) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(parsed));
}

export function formatResetLong(value: string): string {
  const parsed = parseIsoMs(value);
  if (!Number.isFinite(parsed)) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(parsed));
}

export function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return 'Unknown';
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  }

  return Math.round(value).toLocaleString('en-US');
}

export function formatTokenUsage(usage: TokenUsage): string {
  const format = (value: number): string => `${Math.round(value / 1000).toLocaleString('en-US')} K`;
  return `input ${format(usage.inputTokens)}, cached ${format(usage.cachedInputTokens)}, output ${format(usage.outputTokens)}, reasoning ${format(usage.reasoningOutputTokens)}`;
}

export function isUsageOutdated(window: UsageWindow): boolean {
  return parseIsoMs(window.resetsAt) <= Date.now();
}

export function getTimeProgressPercent(window: UsageWindow): number {
  const resetMs = parseIsoMs(window.resetsAt);
  if (!Number.isFinite(resetMs)) {
    return 0;
  }

  const windowMs = window.windowMinutes * 60 * 1000;
  const remainingMs = Math.max(0, resetMs - Date.now());
  const elapsedPercent = 100 - ((remainingMs / windowMs) * 100);
  return clampPercent(elapsedPercent);
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function getDisplayPercentValue(window: UsageWindow, mode: UsageDashboardReadyState['percentDisplayMode']): number {
  return mode === 'used'
    ? clampPercent(window.usedPercent)
    : clampPercent(100 - window.usedPercent);
}

export function formatDisplayPercent(window: UsageWindow, mode: UsageDashboardReadyState['percentDisplayMode']): string {
  const value = Math.round(getDisplayPercentValue(window, mode) * 10) / 10;
  return Number.isInteger(value) ? `${value.toFixed(0)}%` : `${value.toFixed(1)}%`;
}

export function formatPercentValue(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

export function isFiveHourWindow(window: UsageWindow): boolean {
  return Math.abs(window.windowMinutes - FIVE_HOUR_WINDOW_MINUTES) <= 5;
}

export function isWeeklyWindow(window: UsageWindow): boolean {
  return Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES) <= 60;
}

export function formatWindowLabel(windowMinutes: number, compact: boolean): string {
  if (windowMinutes >= 1440 && windowMinutes % 1440 === 0) {
    const days = windowMinutes / 1440;
    return compact ? `${days}D` : `${days}-Day Window`;
  }
  if (windowMinutes >= 60 && windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return compact ? `${hours}H` : `${hours}-Hour Window`;
  }
  return compact ? `${windowMinutes}M` : `${windowMinutes}-Minute Window`;
}

export function getUsageWindowDescriptors(snapshot?: UsageSnapshot): UsageWindowDescriptor[] {
  const windows = [snapshot?.primary, snapshot?.secondary].filter((window): window is UsageWindow => !!window);
  const descriptors = windows.map((window) => {
    if (isFiveHourWindow(window)) {
      return { key: 'fiveHour' as const, shortLabel: '5H', longLabel: '5-Hour Session', icon: '5H', window };
    }
    if (isWeeklyWindow(window)) {
      return { key: 'weekly' as const, shortLabel: 'Weekly', longLabel: 'Weekly Limit', icon: '7D', window };
    }
    return {
      key: 'other' as const,
      shortLabel: formatWindowLabel(window.windowMinutes, true),
      longLabel: formatWindowLabel(window.windowMinutes, false),
      icon: formatWindowLabel(window.windowMinutes, true),
      window
    };
  });

  return descriptors.sort((left, right) => {
    const leftOrder = left.key === 'fiveHour' ? 0 : left.key === 'weekly' ? 1 : 2;
    const rightOrder = right.key === 'fiveHour' ? 0 : right.key === 'weekly' ? 1 : 2;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.window.windowMinutes - right.window.windowMinutes;
  });
}

export function getHistoryRangeLabel(range: UsageHistoryRange): string {
  switch (range) {
    case 'day':
      return 'Daily';
    case 'month':
      return 'Monthly';
    case 'year':
      return 'Yearly';
    default:
      return 'Weekly';
  }
}

export function getUsageHistoryRangeWindowMs(range: UsageHistoryRange): number {
  switch (range) {
    case 'day':
      return 24 * 60 * 60 * 1000;
    case 'month':
      return 31 * 24 * 60 * 60 * 1000;
    case 'year':
      return 366 * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}

export function getUsageHistorySamplesForRange(history: UsageHistorySample[], range: UsageHistoryRange): UsageHistorySample[] {
  const threshold = Date.now() - getUsageHistoryRangeWindowMs(range);
  return history.filter((sample) => {
    const recordedAtMs = parseIsoMs(sample.recordedAt);
    return Number.isFinite(recordedAtMs) && recordedAtMs >= threshold;
  });
}

export function getUsageHistorySourceLabel(sourceFile?: string): string {
  if (!sourceFile) {
    return 'unknown';
  }
  if (sourceFile === 'codex app-server') {
    return 'app-server';
  }
  if (sourceFile === 'experimental web usage') {
    return 'experimental web';
  }
  return 'session file';
}

export function getUsageHistoryContextLabel(sourceFile?: string): string | undefined {
  if (!sourceFile) {
    return undefined;
  }
  if (sourceFile === 'codex app-server') {
    return 'Live app-server snapshot';
  }
  if (sourceFile === 'experimental web usage') {
    return 'Experimental web snapshot';
  }

  const segments = sourceFile.replace(/\\/g, '/').split('/');
  const fileName = segments[segments.length - 1];
  return fileName ? `Session file ${fileName}` : 'Local session file';
}

export function getSeverityTone(
  window: UsageWindow,
  warningThreshold: number,
  criticalThreshold: number
): 'normal' | 'warning' | 'critical' | 'outdated' {
  if (isUsageOutdated(window)) {
    return 'outdated';
  }
  if (window.usedPercent >= criticalThreshold) {
    return 'critical';
  }
  if (window.usedPercent >= warningThreshold) {
    return 'warning';
  }
  return 'normal';
}

export function getPeakUsageValue(
  samples: UsageHistorySample[],
  key: 'primaryUsedPercent' | 'secondaryUsedPercent'
): number | undefined {
  const values = samples
    .map((sample) => sample[key])
    .filter((value): value is number => typeof value === 'number');
  if (!values.length) {
    return undefined;
  }
  return Math.max(...values);
}

export function buildUsageHistoryPointList(
  samples: UsageHistorySample[],
  key: 'primaryUsedPercent' | 'secondaryUsedPercent'
): Array<{ sample: UsageHistorySample; value: number; recordedAtMs: number }> {
  return samples.flatMap((sample) => {
    const value = sample[key];
    const recordedAtMs = parseIsoMs(sample.recordedAt);
    return typeof value === 'number' && Number.isFinite(recordedAtMs)
      ? [{ sample, value, recordedAtMs }]
      : [];
  });
}

export function getUsageHistoryPointX(recordedAtMs: number, startMs: number, endMs: number, width: number): number {
  if (!Number.isFinite(recordedAtMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  return Math.round((((recordedAtMs - startMs) / (endMs - startMs)) * width) * 100) / 100;
}

export function buildUsageHistorySparklinePath(
  points: Array<{ sample: UsageHistorySample; value: number; recordedAtMs: number }>,
  width: number,
  height: number,
  startMs: number,
  endMs: number
): string {
  if (!points.length) {
    return '';
  }

  return points.map((point, index) => {
    const x = getUsageHistoryPointX(point.recordedAtMs, startMs, endMs, width);
    const y = Math.round((height - ((clampPercent(point.value) / 100) * height)) * 100) / 100;
    return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
  }).join(' ');
}

export function formatUsageHistoryTooltip(sample: UsageHistorySample, label: string, value: number): string {
  const lines = [
    `${label}: ${formatPercentValue(value)} used`,
    `Recorded: ${formatTimestamp(sample.recordedAt)}`
  ];

  if (typeof sample.primaryUsedPercent === 'number') {
    lines.push(`5H: ${formatPercentValue(sample.primaryUsedPercent)} used`);
  }
  if (typeof sample.secondaryUsedPercent === 'number') {
    lines.push(`Weekly: ${formatPercentValue(sample.secondaryUsedPercent)} used`);
  }
  if (sample.lastUsage) {
    lines.push(`Last tokens: ${formatTokenUsage(sample.lastUsage)}`);
  }
  if (sample.totalUsage) {
    lines.push(`Total tokens: ${formatTokenUsage(sample.totalUsage)}`);
  }
  if (sample.sourceFile) {
    lines.push(`Source: ${getUsageHistorySourceLabel(sample.sourceFile)}`);
    const contextLabel = getUsageHistoryContextLabel(sample.sourceFile);
    if (contextLabel) {
      lines.push(`Context: ${contextLabel}`);
    }
  }

  return lines.join('\n');
}

export function joinNonEmpty(parts: Array<string | undefined>): string {
  return parts.filter((value): value is string => !!value).join(' • ');
}

export function getActiveProfile(state: UsageDashboardReadyState): UsagePanelProfile | undefined {
  return state.profiles.find((profile) => profile.id === state.activeProfileId);
}

export function getCompareProfile(state: UsageDashboardReadyState): UsagePanelProfile | undefined {
  return state.profiles.find((profile) => profile.id === state.compareProfileId);
}

export function getCompareCandidates(state: UsageDashboardReadyState): UsagePanelProfile[] {
  return state.profiles.filter((profile) => profile.id !== state.activeProfileId);
}

export function renderEmptyMessage(message: string, detail: string): ComponentChildren {
  return (
    <div class="empty-state">
      <div class="empty-state__title">{message}</div>
      <div class="empty-state__copy">{detail}</div>
    </div>
  );
}

export function isReadyState(state: UsageDashboardState | undefined): state is UsageDashboardReadyState {
  return !!state && state.kind === 'ready';
}
