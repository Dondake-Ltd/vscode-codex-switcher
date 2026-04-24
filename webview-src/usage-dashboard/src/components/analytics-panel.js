"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalyticsPanel = AnalyticsPanel;
const helpers_1 = require("../helpers");
function UsageWindowSection(props) {
    const { descriptor, state } = props;
    const displayPercent = (0, helpers_1.getDisplayPercentValue)(descriptor.window, state.percentDisplayMode);
    const tone = (0, helpers_1.getSeverityTone)(descriptor.window, state.warningThreshold, state.criticalThreshold);
    const timePercent = (0, helpers_1.getTimeProgressPercent)(descriptor.window);
    return (<section class="analytics-panel__section">
      <div class="analytics-panel__section-head">
        <h4>{descriptor.longLabel}</h4>
        <span class={`badge badge--${tone}`}>{(0, helpers_1.formatDisplayPercent)(descriptor.window, state.percentDisplayMode)} {state.percentDisplaySuffixCompact}</span>
      </div>
      <div class="analytics-row">
        <div class="analytics-row__label">Usage</div>
        <div class="linear-meter">
          <div class={`linear-meter__fill linear-meter__fill--${tone}`} style={{ width: `${displayPercent}%` }}/>
        </div>
        <strong>{(0, helpers_1.formatDisplayPercent)(descriptor.window, state.percentDisplayMode)}</strong>
      </div>
      <div class="analytics-row">
        <div class="analytics-row__label">Time</div>
        <div class="linear-meter">
          <div class="linear-meter__fill linear-meter__fill--time" style={{ width: `${timePercent}%` }}/>
        </div>
        <strong>{(0, helpers_1.formatPercentValue)(timePercent)}</strong>
      </div>
      <div class="analytics-panel__detail">Reset {(0, helpers_1.formatResetLong)(descriptor.window.resetsAt)}</div>
    </section>);
}
function HistoryChart(props) {
    const chartWidth = 520;
    const chartHeight = 196;
    const chartOffsetLeft = 40;
    const chartOffsetBottom = 30;
    const svgWidth = chartWidth + chartOffsetLeft;
    const svgHeight = chartHeight + chartOffsetBottom;
    const startMs = (0, helpers_1.parseIsoMs)(props.samples[0]?.recordedAt);
    const endMs = (0, helpers_1.parseIsoMs)(props.samples[props.samples.length - 1]?.recordedAt);
    const fiveHourPoints = (0, helpers_1.buildUsageHistoryPointList)(props.samples, 'primaryUsedPercent');
    const weeklyPoints = (0, helpers_1.buildUsageHistoryPointList)(props.samples, 'secondaryUsedPercent');
    const series = [
        fiveHourPoints.length
            ? {
                key: 'five-hour',
                label: '5H',
                colorClass: 'history-series--green',
                stroke: 'var(--chart-green)',
                peak: (0, helpers_1.getPeakUsageValue)(props.samples, 'primaryUsedPercent'),
                path: (0, helpers_1.buildUsageHistorySparklinePath)(fiveHourPoints, chartWidth, chartHeight, startMs, endMs),
                points: fiveHourPoints
            }
            : undefined,
        weeklyPoints.length
            ? {
                key: 'weekly',
                label: 'Weekly',
                colorClass: 'history-series--blue',
                stroke: 'var(--chart-blue)',
                peak: (0, helpers_1.getPeakUsageValue)(props.samples, 'secondaryUsedPercent'),
                path: (0, helpers_1.buildUsageHistorySparklinePath)(weeklyPoints, chartWidth, chartHeight, startMs, endMs),
                points: weeklyPoints
            }
            : undefined
    ].filter((entry) => !!entry);
    const axisLevels = [100, 75, 50, 25, 0];
    return (<div class="history-card">
      <div class="history-card__stats">
        <div class="history-stat">
          <span>Range</span>
          <strong>{(0, helpers_1.getHistoryRangeLabel)(props.state.historyRange)}</strong>
        </div>
        <div class="history-stat">
          <span>Samples</span>
          <strong>{props.samples.length}</strong>
        </div>
        {series.map((entry) => (<div class="history-stat" key={entry.key}>
            <span>Peak {entry.label}</span>
            <strong>{entry.peak !== undefined ? (0, helpers_1.formatPercentValue)(entry.peak) : 'Unknown'}</strong>
          </div>))}
      </div>
      <div class="history-chart">
        <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} width="100%" height="232" role="img" aria-label="Usage history chart">
          <g transform={`translate(${chartOffsetLeft},0)`}>
            <rect x="0" y="0" width={chartWidth} height={Math.round(chartHeight * 0.25)} fill="rgba(222, 82, 67, 0.10)"/>
            <rect x="0" y={Math.round(chartHeight * 0.25)} width={chartWidth} height={Math.round(chartHeight * 0.25)} fill="rgba(224, 166, 40, 0.08)"/>
            <rect x="0" y={Math.round(chartHeight * 0.5)} width={chartWidth} height={Math.round(chartHeight * 0.5)} fill="rgba(41, 158, 111, 0.06)"/>
            {axisLevels.map((level) => {
            const y = Math.round((chartHeight - ((level / 100) * chartHeight)) * 100) / 100;
            return <line key={level} x1="0" y1={y} x2={chartWidth} y2={y} class="history-chart__grid"/>;
        })}
            <line x1="0" y1="0" x2="0" y2={chartHeight} class="history-chart__axis"/>
            <line x1="0" y1={chartHeight} x2={chartWidth} y2={chartHeight} class="history-chart__axis"/>
            {series.map((entry) => (<g key={entry.key} class={`history-series ${entry.colorClass}`}>
                {entry.path ? <path d={entry.path} fill="none" stroke={entry.stroke} stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/> : null}
                {entry.points.map((point) => {
                const x = (0, helpers_1.getUsageHistoryPointX)(point.recordedAtMs, startMs, endMs, chartWidth);
                const y = Math.round((chartHeight - ((Math.max(0, Math.min(100, point.value)) / 100) * chartHeight)) * 100) / 100;
                return (<g key={`${entry.key}:${point.sample.recordedAt}`}>
                      <title>{(0, helpers_1.formatUsageHistoryTooltip)(point.sample, entry.label, point.value)}</title>
                      <circle cx={x} cy={y} r="4.5"/>
                    </g>);
            })}
              </g>))}
          </g>
          {axisLevels.map((level) => {
            const y = Math.round((chartHeight - ((level / 100) * chartHeight)) * 100) / 100;
            return (<text key={`axis:${level}`} x={chartOffsetLeft - 8} y={y + 4} text-anchor="end" class="history-chart__axis-label">
                {level}%
              </text>);
        })}
          <text x="14" y={Math.round(chartHeight / 2)} transform={`rotate(-90 14 ${Math.round(chartHeight / 2)})`} text-anchor="middle" class="history-chart__axis-label">
            Used %
          </text>
          <text x={chartOffsetLeft + chartWidth / 2} y={chartHeight + 24} text-anchor="middle" class="history-chart__axis-label">
            Recorded time
          </text>
        </svg>
      </div>
      <div class="history-card__footer">
        <span>{(0, helpers_1.formatTimestamp)(props.samples[0]?.recordedAt ?? '')}</span>
        <span>{(0, helpers_1.formatTimestamp)(props.samples[props.samples.length - 1]?.recordedAt ?? '')}</span>
      </div>
      <div class="history-card__legend">
        {series.map((entry) => (<span key={`legend:${entry.key}`} class="history-legend">
            <span class={`history-legend__line ${entry.colorClass}`}/>
            {entry.label} used %
          </span>))}
        <span class="history-legend">Hover points for usage, tokens, and source</span>
      </div>
    </div>);
}
function RecentSamples(props) {
    const rows = [...props.samples].slice(-5).reverse();
    return (<div class="sample-table">
      <div class="sample-table__header">
        <span>Recorded</span>
        <span>5H</span>
        <span>Week</span>
        <span>Source</span>
      </div>
      {rows.map((sample) => {
            const primary = typeof sample.primaryUsedPercent === 'number' ? (0, helpers_1.formatPercentValue)(sample.primaryUsedPercent) : '—';
            const secondary = typeof sample.secondaryUsedPercent === 'number' ? (0, helpers_1.formatPercentValue)(sample.secondaryUsedPercent) : '—';
            const hoverValue = typeof sample.primaryUsedPercent === 'number'
                ? sample.primaryUsedPercent
                : typeof sample.secondaryUsedPercent === 'number'
                    ? sample.secondaryUsedPercent
                    : 0;
            const hoverLabel = typeof sample.primaryUsedPercent === 'number'
                ? '5H'
                : typeof sample.secondaryUsedPercent === 'number'
                    ? 'Weekly'
                    : 'Usage';
            return (<div key={sample.recordedAt} class="sample-table__row" title={(0, helpers_1.formatUsageHistoryTooltip)(sample, hoverLabel, hoverValue)}>
            <strong>{(0, helpers_1.formatTimestamp)(sample.recordedAt)}</strong>
            <span>{primary}</span>
            <span>{secondary}</span>
            <span>{(0, helpers_1.getUsageHistorySourceLabel)(sample.sourceFile)}</span>
          </div>);
        })}
    </div>);
}
function TokenPanel(props) {
    if (!props.profile.snapshot?.totalUsage && !props.profile.snapshot?.lastUsage) {
        return (0, helpers_1.renderEmptyMessage)('No token usage yet', 'Prompt Codex on this profile once to populate total and last token totals.');
    }
    return (<section class="analytics-panel__section analytics-panel__section--token">
      <div class="analytics-panel__section-head">
        <h4>Token Usage</h4>
        {props.profile.snapshot?.totalUsage
            ? <span class="badge">{(0, helpers_1.formatCompactTokenCount)(props.profile.snapshot.totalUsage.totalTokens)} total</span>
            : null}
      </div>
      {props.profile.snapshot?.totalUsage ? <div class="analytics-panel__detail"><strong>Total:</strong> {(0, helpers_1.formatTokenUsage)(props.profile.snapshot.totalUsage)}</div> : null}
      {props.profile.snapshot?.lastUsage ? <div class="analytics-panel__detail"><strong>Last:</strong> {(0, helpers_1.formatTokenUsage)(props.profile.snapshot.lastUsage)}</div> : null}
      {props.profile.isStale ? <div class="analytics-panel__warning">Last-known data only. Use Codex once after switching to refresh it.</div> : null}
    </section>);
}
function AnalyticsPanel(props) {
    const descriptors = (0, helpers_1.getUsageWindowDescriptors)(props.profile.snapshot);
    const samples = (0, helpers_1.getUsageHistorySamplesForRange)(props.profile.history, props.state.historyRange);
    const latestSample = samples[samples.length - 1];
    const subtitle = (0, helpers_1.joinNonEmpty)([
        props.profile.email && props.profile.email !== 'Unknown' ? props.profile.email : undefined,
        props.profile.planType && props.profile.planType !== 'Unknown' ? props.profile.planType : undefined
    ]);
    return (<article class="analytics-panel">
      <div class="analytics-panel__header">
        <div>
          <div class={`badge badge--${props.roleTone}`}>{props.roleLabel}</div>
          <h3>{props.profile.name}</h3>
          <p>{subtitle || 'No profile metadata'}</p>
        </div>
        <div>{props.headerAction}</div>
      </div>
      <section class="analytics-panel__section analytics-panel__section--provenance">
        <div class="analytics-panel__provenance">
          <div>
            <span>Source</span>
            <strong>{props.profile.isStale ? `${props.profile.sourceLabel} (pre-switch cached)` : props.profile.sourceLabel}</strong>
          </div>
          <div>
            <span>Updated</span>
            <strong>{props.profile.updatedLabel}</strong>
          </div>
          <div>
            <span>Refresh</span>
            <strong>{props.profile.refreshStatus ?? 'No recent refresh recorded'}</strong>
          </div>
        </div>
      </section>
      {!descriptors.length ? (0, helpers_1.renderEmptyMessage)('Remaining usage is unknown', 'No live usage windows were found for this profile. Check the refresh status above to see whether the last refresh found nothing newer.') : descriptors.map((descriptor) => (<UsageWindowSection key={descriptor.longLabel} state={props.state} descriptor={descriptor}/>))}
      <section class="analytics-panel__section">
        <div class="analytics-panel__section-head">
          <h4>Usage History</h4>
          <span class="badge">{(0, helpers_1.getHistoryRangeLabel)(props.state.historyRange)}</span>
        </div>
        {samples.length ? (<div class="analytics-panel__history-stack">
            <div class="history-summary">
              <div>
                <span>Latest sample</span>
                <strong>{(0, helpers_1.formatTimestamp)(latestSample.recordedAt)}</strong>
              </div>
              <div>
                <span>Source</span>
                <strong>{(0, helpers_1.getUsageHistorySourceLabel)(latestSample.sourceFile)}</strong>
              </div>
              <div>
                <span>Context</span>
                <strong>{(0, helpers_1.getUsageHistoryContextLabel)(latestSample.sourceFile) ?? 'No extra context'}</strong>
              </div>
              <div>
                <span>5H Used</span>
                <strong>{typeof latestSample.primaryUsedPercent === 'number' ? (0, helpers_1.formatPercentValue)(latestSample.primaryUsedPercent) : 'Unknown'}</strong>
              </div>
              <div>
                <span>Weekly Used</span>
                <strong>{typeof latestSample.secondaryUsedPercent === 'number' ? (0, helpers_1.formatPercentValue)(latestSample.secondaryUsedPercent) : 'Unknown'}</strong>
              </div>
              <div>
                <span>Total Tokens</span>
                <strong>{latestSample.totalUsage ? (0, helpers_1.formatCompactTokenCount)(latestSample.totalUsage.totalTokens) : 'Unknown'}</strong>
              </div>
            </div>
            <HistoryChart state={props.state} samples={samples}/>
            <RecentSamples samples={samples}/>
          </div>) : (0, helpers_1.renderEmptyMessage)('No historical samples yet', 'Remaining usage is unknown until Codex emits fresh usage data for this profile.')}
      </section>
      <TokenPanel profile={props.profile}/>
    </article>);
}
//# sourceMappingURL=analytics-panel.js.map