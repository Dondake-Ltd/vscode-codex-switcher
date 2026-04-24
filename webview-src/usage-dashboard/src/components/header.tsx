import { h } from 'preact';
import type { UsageDashboardReadyState } from '../../../../src/usageDashboardTypes';
import { getCompareCandidates, getHistoryRangeLabel } from '../helpers';

type HeaderProps = {
  state: UsageDashboardReadyState;
  onRefresh: () => void;
  onHistoryRangeChange: (value: UsageDashboardReadyState['historyRange']) => void;
  onCompareChange: (value: string) => void;
  pendingAction: string | undefined;
};

export function DashboardHeader(props: HeaderProps) {
  const compareCandidates = getCompareCandidates(props.state);

  return (
    <header class="dashboard-hero">
      <div class="dashboard-hero__brand">
        <div class="dashboard-hero__kicker">Profile Dashboard</div>
        <h1>Codex Usage</h1>
      </div>
      <div class="dashboard-hero__controls">
        <label class="control-field">
          <span>History</span>
          <select
            value={props.state.historyRange}
            onChange={(event) => props.onHistoryRangeChange(event.currentTarget.value as UsageDashboardReadyState['historyRange'])}
          >
            <option value="day">{getHistoryRangeLabel('day')}</option>
            <option value="week">{getHistoryRangeLabel('week')}</option>
            <option value="month">{getHistoryRangeLabel('month')}</option>
            <option value="year">{getHistoryRangeLabel('year')}</option>
          </select>
        </label>
        <label class="control-field">
          <span>Compare</span>
          <select
            value={props.state.compareProfileId}
            onChange={(event) => props.onCompareChange(event.currentTarget.value)}
            disabled={!compareCandidates.length}
          >
            {compareCandidates.length
              ? compareCandidates.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))
              : <option value={props.state.activeProfileId}>No other saved profiles</option>}
          </select>
        </label>
        <button type="button" class="button button--primary" onClick={props.onRefresh} disabled={props.pendingAction === 'refresh'}>
          {props.pendingAction === 'refresh' ? 'Refreshing…' : 'Refresh Usage'}
        </button>
      </div>
    </header>
  );
}
