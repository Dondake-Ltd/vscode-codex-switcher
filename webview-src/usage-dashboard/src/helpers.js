"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseIsoMs = parseIsoMs;
exports.formatTimestamp = formatTimestamp;
exports.formatResetLong = formatResetLong;
exports.formatCompactTokenCount = formatCompactTokenCount;
exports.formatTokenUsage = formatTokenUsage;
exports.isUsageOutdated = isUsageOutdated;
exports.getTimeProgressPercent = getTimeProgressPercent;
exports.clampPercent = clampPercent;
exports.getDisplayPercentValue = getDisplayPercentValue;
exports.formatDisplayPercent = formatDisplayPercent;
exports.formatPercentValue = formatPercentValue;
exports.isFiveHourWindow = isFiveHourWindow;
exports.isWeeklyWindow = isWeeklyWindow;
exports.formatWindowLabel = formatWindowLabel;
exports.getUsageWindowDescriptors = getUsageWindowDescriptors;
exports.getHistoryRangeLabel = getHistoryRangeLabel;
exports.getUsageHistoryRangeWindowMs = getUsageHistoryRangeWindowMs;
exports.getUsageHistorySamplesForRange = getUsageHistorySamplesForRange;
exports.getUsageHistorySourceLabel = getUsageHistorySourceLabel;
exports.getUsageHistoryContextLabel = getUsageHistoryContextLabel;
exports.getSeverityTone = getSeverityTone;
exports.getPeakUsageValue = getPeakUsageValue;
exports.buildUsageHistoryPointList = buildUsageHistoryPointList;
exports.getUsageHistoryPointX = getUsageHistoryPointX;
exports.buildUsageHistorySparklinePath = buildUsageHistorySparklinePath;
exports.formatUsageHistoryTooltip = formatUsageHistoryTooltip;
exports.joinNonEmpty = joinNonEmpty;
exports.getActiveProfile = getActiveProfile;
exports.getCompareProfile = getCompareProfile;
exports.getCompareCandidates = getCompareCandidates;
exports.renderEmptyMessage = renderEmptyMessage;
exports.isReadyState = isReadyState;
const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
function parseIsoMs(value) {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}
function formatTimestamp(value) {
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
function formatResetLong(value) {
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
function formatCompactTokenCount(value) {
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
function formatTokenUsage(usage) {
    const format = (value) => `${Math.round(value / 1000).toLocaleString('en-US')} K`;
    return `input ${format(usage.inputTokens)}, cached ${format(usage.cachedInputTokens)}, output ${format(usage.outputTokens)}, reasoning ${format(usage.reasoningOutputTokens)}`;
}
function isUsageOutdated(window) {
    return parseIsoMs(window.resetsAt) <= Date.now();
}
function getTimeProgressPercent(window) {
    const resetMs = parseIsoMs(window.resetsAt);
    if (!Number.isFinite(resetMs)) {
        return 0;
    }
    const windowMs = window.windowMinutes * 60 * 1000;
    const remainingMs = Math.max(0, resetMs - Date.now());
    const elapsedPercent = 100 - ((remainingMs / windowMs) * 100);
    return clampPercent(elapsedPercent);
}
function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
}
function getDisplayPercentValue(window, mode) {
    return mode === 'used'
        ? clampPercent(window.usedPercent)
        : clampPercent(100 - window.usedPercent);
}
function formatDisplayPercent(window, mode) {
    const value = Math.round(getDisplayPercentValue(window, mode) * 10) / 10;
    return Number.isInteger(value) ? `${value.toFixed(0)}%` : `${value.toFixed(1)}%`;
}
function formatPercentValue(value) {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}
function isFiveHourWindow(window) {
    return Math.abs(window.windowMinutes - FIVE_HOUR_WINDOW_MINUTES) <= 5;
}
function isWeeklyWindow(window) {
    return Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES) <= 60;
}
function formatWindowLabel(windowMinutes, compact) {
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
function getUsageWindowDescriptors(snapshot) {
    const windows = [snapshot?.primary, snapshot?.secondary].filter((window) => !!window);
    const descriptors = windows.map((window) => {
        if (isFiveHourWindow(window)) {
            return { key: 'fiveHour', shortLabel: '5H', longLabel: '5-Hour Session', icon: '5H', window };
        }
        if (isWeeklyWindow(window)) {
            return { key: 'weekly', shortLabel: 'Weekly', longLabel: 'Weekly Limit', icon: '7D', window };
        }
        return {
            key: 'other',
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
function getHistoryRangeLabel(range) {
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
function getUsageHistoryRangeWindowMs(range) {
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
function getUsageHistorySamplesForRange(history, range) {
    const threshold = Date.now() - getUsageHistoryRangeWindowMs(range);
    return history.filter((sample) => {
        const recordedAtMs = parseIsoMs(sample.recordedAt);
        return Number.isFinite(recordedAtMs) && recordedAtMs >= threshold;
    });
}
function getUsageHistorySourceLabel(sourceFile) {
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
function getUsageHistoryContextLabel(sourceFile) {
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
function getSeverityTone(window, warningThreshold, criticalThreshold) {
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
function getPeakUsageValue(samples, key) {
    const values = samples
        .map((sample) => sample[key])
        .filter((value) => typeof value === 'number');
    if (!values.length) {
        return undefined;
    }
    return Math.max(...values);
}
function buildUsageHistoryPointList(samples, key) {
    return samples.flatMap((sample) => {
        const value = sample[key];
        const recordedAtMs = parseIsoMs(sample.recordedAt);
        return typeof value === 'number' && Number.isFinite(recordedAtMs)
            ? [{ sample, value, recordedAtMs }]
            : [];
    });
}
function getUsageHistoryPointX(recordedAtMs, startMs, endMs, width) {
    if (!Number.isFinite(recordedAtMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return 0;
    }
    return Math.round((((recordedAtMs - startMs) / (endMs - startMs)) * width) * 100) / 100;
}
function buildUsageHistorySparklinePath(points, width, height, startMs, endMs) {
    if (!points.length) {
        return '';
    }
    return points.map((point, index) => {
        const x = getUsageHistoryPointX(point.recordedAtMs, startMs, endMs, width);
        const y = Math.round((height - ((clampPercent(point.value) / 100) * height)) * 100) / 100;
        return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
    }).join(' ');
}
function formatUsageHistoryTooltip(sample, label, value) {
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
function joinNonEmpty(parts) {
    return parts.filter((value) => !!value).join(' • ');
}
function getActiveProfile(state) {
    return state.profiles.find((profile) => profile.id === state.activeProfileId);
}
function getCompareProfile(state) {
    return state.profiles.find((profile) => profile.id === state.compareProfileId);
}
function getCompareCandidates(state) {
    return state.profiles.filter((profile) => profile.id !== state.activeProfileId);
}
function renderEmptyMessage(message, detail) {
    return (<div class="empty-state">
      <div class="empty-state__title">{message}</div>
      <div class="empty-state__copy">{detail}</div>
    </div>);
}
function isReadyState(state) {
    return !!state && state.kind === 'ready';
}
//# sourceMappingURL=helpers.js.map