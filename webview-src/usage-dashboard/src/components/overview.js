"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OverviewSection = OverviewSection;
const helpers_1 = require("../helpers");
function GaugeCard(props) {
    const { descriptor, state } = props;
    const displayPercent = (0, helpers_1.getDisplayPercentValue)(descriptor.window, state.percentDisplayMode);
    const timePercent = (0, helpers_1.getTimeProgressPercent)(descriptor.window);
    const tone = (0, helpers_1.getSeverityTone)(descriptor.window, state.warningThreshold, state.criticalThreshold);
    const degrees = 180 * (displayPercent / 100);
    return (<article class={`gauge-card gauge-card--${tone}`}>
      <div class="gauge-card__dial" style={{ ['--gauge-degrees']: `${degrees}deg` }}>
        <div class="gauge-card__dial-center">
          <strong>{(0, helpers_1.formatDisplayPercent)(descriptor.window, state.percentDisplayMode)}</strong>
          <span>{state.percentDisplaySuffixCompact}</span>
        </div>
      </div>
      <div class="gauge-card__meta">
        <div class="gauge-card__title">{descriptor.shortLabel}</div>
        <div class="gauge-card__detail">Reset {(0, helpers_1.formatResetLong)(descriptor.window.resetsAt)}</div>
        <div class="gauge-card__detail">Time window {Math.round(timePercent)}% elapsed</div>
      </div>
    </article>);
}
function OverviewSection(props) {
    const descriptors = (0, helpers_1.getUsageWindowDescriptors)(props.profile.snapshot);
    const subtitle = (0, helpers_1.joinNonEmpty)([
        props.profile.email && props.profile.email !== 'Unknown' ? props.profile.email : undefined,
        props.profile.planType && props.profile.planType !== 'Unknown' ? props.profile.planType : undefined
    ]);
    const totalTokens = props.profile.snapshot?.totalUsage?.totalTokens;
    const lastTokens = props.profile.snapshot?.lastUsage?.totalTokens;
    return (<section class="overview-shell">
      <article class="spotlight-card">
        <div class="spotlight-card__eyebrow">Active Profile</div>
        <h2>{props.profile.name}</h2>
        <p>{subtitle || 'No profile metadata'}</p>
        <div class="spotlight-card__chips">
          <span class="badge badge--active">Current</span>
          {props.profile.isStale ? <span class="badge badge--warning">Stale</span> : <span class="badge badge--healthy">Healthy</span>}
          {props.profile.snapshot?.sourceFile ? <span class="badge">{(0, helpers_1.getUsageHistorySourceLabel)(props.profile.snapshot.sourceFile)}</span> : null}
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
            <span>Total {totalTokens !== undefined ? (0, helpers_1.formatCompactTokenCount)(totalTokens) : 'Unknown'}</span>
            <span>Last {lastTokens !== undefined ? (0, helpers_1.formatCompactTokenCount)(lastTokens) : 'Unknown'}</span>
          </div>
        </div>
        <div class="overview-metrics__grid">
          {descriptors.length
            ? descriptors.map((descriptor) => <GaugeCard key={descriptor.longLabel} state={props.state} descriptor={descriptor}/>)
            : (0, helpers_1.renderEmptyMessage)('No live usage yet', 'Prompt Codex on this profile once to populate the dashboard.')}
        </div>
      </article>
      <article class="overview-sidebar">
        <div class="section-kicker">What Changed</div>
        <h3>Dashboard-first workflow</h3>
        <p>
          Saved profiles sit up front, the active profile gets the main spotlight, and deeper analytics stay one scroll away.
        </p>
        <ul class="overview-sidebar__list">
          <li>Historical timing stays aligned to real sample timestamps.</li>
          <li>Compare mode still supports instant profile switching.</li>
          <li>Token totals and refresh provenance stay visible.</li>
        </ul>
      </article>
    </section>);
}
//# sourceMappingURL=overview.js.map