import { h } from 'preact';
import type { UsageDashboardReadyState, UsagePanelProfile } from '../../../../src/usageDashboardTypes';
import {
  formatCompactTokenCount,
  formatDisplayPercent,
  formatResetLong,
  getDisplayPercentValue,
  getSeverityTone,
  getUsageWindowDescriptors,
  getUsageHistorySourceLabel,
  getTimeProgressPercent,
  joinNonEmpty,
  renderEmptyMessage
} from '../helpers';

type OverviewProps = {
  state: UsageDashboardReadyState;
  profile: UsagePanelProfile;
};

type GaugeCardProps = {
  state: UsageDashboardReadyState;
  descriptor: ReturnType<typeof getUsageWindowDescriptors>[number];
};

function GaugeCard(props: GaugeCardProps) {
  const { descriptor, state } = props;
  const displayPercent = getDisplayPercentValue(descriptor.window, state.percentDisplayMode);
  const timePercent = getTimeProgressPercent(descriptor.window);
  const tone = getSeverityTone(descriptor.window, state.warningThreshold, state.criticalThreshold);
  const gaugeRadius = 76;
  const arcPath = 'M 24 108 A 76 76 0 0 1 176 108';
  const clampedPercent = Math.max(0, Math.min(100, displayPercent));
  const arcLength = Math.PI * gaugeRadius;
  const filledLength = (clampedPercent / 100) * arcLength;
  const remainingLength = Math.max(0, arcLength - filledLength);

  return (
    <article class={`gauge-card gauge-card--${tone}`}>
      <div class="gauge-card__dial">
        <svg
          class="gauge-card__svg"
          viewBox="0 0 200 132"
          role="img"
          aria-label={`${descriptor.longLabel} ${formatDisplayPercent(descriptor.window, state.percentDisplayMode)} ${state.percentDisplaySuffixCompact}`}
        >
          <path class="gauge-card__track" d={arcPath} />
          <path
            class={`gauge-card__progress gauge-card__progress--${tone}`}
            d={arcPath}
            strokeDasharray={`${filledLength} ${remainingLength}`}
          />
        </svg>
        <div class="gauge-card__dial-center">
          <strong>{formatDisplayPercent(descriptor.window, state.percentDisplayMode)}</strong>
          <span>{state.percentDisplaySuffixCompact}</span>
        </div>
      </div>
      <div class="gauge-card__meta">
        <div class="gauge-card__title">{descriptor.shortLabel}</div>
        <div class="gauge-card__detail">Reset {formatResetLong(descriptor.window.resetsAt)}</div>
        <div class="gauge-card__detail">Time window {Math.round(timePercent)}% elapsed</div>
      </div>
    </article>
  );
}

export function OverviewSection(props: OverviewProps) {
  const descriptors = getUsageWindowDescriptors(props.profile.snapshot);
  const subtitle = joinNonEmpty([
    props.profile.email && props.profile.email !== 'Unknown' ? props.profile.email : undefined,
    props.profile.planType && props.profile.planType !== 'Unknown' ? props.profile.planType : undefined
  ]);
  const totalTokens = props.profile.snapshot?.totalUsage?.totalTokens;
  const lastTokens = props.profile.snapshot?.lastUsage?.totalTokens;

  return (
    <section class="overview-shell">
      <article class="spotlight-card">
        <div class="spotlight-card__eyebrow">Active Profile</div>
        <h2>{props.profile.name}</h2>
        <p>{subtitle || 'No profile metadata'}</p>
        <div class="spotlight-card__chips">
          <span class="badge badge--active">Current</span>
          {props.profile.isStale ? <span class="badge badge--warning">Stale</span> : <span class="badge badge--healthy">Healthy</span>}
          {props.profile.snapshot?.sourceFile ? <span class="badge">{getUsageHistorySourceLabel(props.profile.snapshot.sourceFile)}</span> : null}
        </div>
        <dl class="spotlight-card__facts">
          <div>
            <dt>Updated</dt>
            <dd>{props.profile.updatedLabel}</dd>
          </div>
          <div>
            <dt>Refresh</dt>
            <dd>{props.profile.refreshStatus ?? 'No recent refresh recorded'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{props.profile.sourceLabel}</dd>
          </div>
        </dl>
      </article>
      <article class="overview-metrics">
        <div class="overview-metrics__header">
          <div>
            <div class="section-kicker">Quota Snapshot</div>
            <h3>Current window usage</h3>
          </div>
          <div class="overview-metrics__tokens">
            <span>Total {totalTokens !== undefined ? formatCompactTokenCount(totalTokens) : 'Unknown'}</span>
            <span>Last {lastTokens !== undefined ? formatCompactTokenCount(lastTokens) : 'Unknown'}</span>
          </div>
        </div>
        <div class="overview-metrics__grid">
          {descriptors.length
            ? descriptors.map((descriptor) => <GaugeCard key={descriptor.longLabel} state={props.state} descriptor={descriptor} />)
            : renderEmptyMessage('No live usage yet', 'Prompt Codex on this profile once to populate the dashboard.')}
        </div>
      </article>
    </section>
  );
}
