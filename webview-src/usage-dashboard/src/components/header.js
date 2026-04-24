"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardHeader = DashboardHeader;
const helpers_1 = require("../helpers");
function DashboardHeader(props) {
    const compareCandidates = (0, helpers_1.getCompareCandidates)(props.state);
    return (<header class="dashboard-hero">
      <div class="dashboard-hero__brand">
        <div class="dashboard-hero__kicker">Profile Dashboard</div>
        <h1>Codex Usage</h1>
      </div>
      <div class="dashboard-hero__controls">
        <label class="control-field">
          <span>History</span>
          <select value={props.state.historyRange} onChange={(event) => props.onHistoryRangeChange(event.currentTarget.value)}>
            <option value="day">{(0, helpers_1.getHistoryRangeLabel)('day')}</option>
            <option value="week">{(0, helpers_1.getHistoryRangeLabel)('week')}</option>
            <option value="month">{(0, helpers_1.getHistoryRangeLabel)('month')}</option>
            <option value="year">{(0, helpers_1.getHistoryRangeLabel)('year')}</option>
          </select>
        </label>
        <label class="control-field">
          <span>Compare</span>
          <select value={props.state.compareProfileId} onChange={(event) => props.onCompareChange(event.currentTarget.value)} disabled={!compareCandidates.length}>
            {compareCandidates.length
            ? compareCandidates.map((profile) => (<option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>))
            : <option value={props.state.activeProfileId}>No other saved profiles</option>}
          </select>
        </label>
        <button type="button" class="button button--primary" onClick={props.onRefresh} disabled={props.pendingAction === 'refresh'}>
          {props.pendingAction === 'refresh' ? 'Refreshing…' : 'Refresh Usage'}
        </button>
      </div>
    </header>);
}
//# sourceMappingURL=header.js.map
