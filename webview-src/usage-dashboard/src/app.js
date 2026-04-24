"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.App = App;
const hooks_1 = require("preact/hooks");
const header_1 = require("./components/header");
const overview_1 = require("./components/overview");
const profile_grid_1 = require("./components/profile-grid");
const analytics_panel_1 = require("./components/analytics-panel");
const helpers_1 = require("./helpers");
const vscode_1 = require("./vscode");
const vscode = (0, vscode_1.getVsCodeApi)();
function postMessage(message) {
    vscode.postMessage(message);
}
function App() {
    const [state, setState] = (0, hooks_1.useState)(() => vscode.getState());
    const [pendingAction, setPendingAction] = (0, hooks_1.useState)();
    (0, hooks_1.useEffect)(() => {
        const handleMessage = (event) => {
            const message = event.data;
            if (message?.type !== 'render' || !message.state) {
                return;
            }
            setState(message.state);
            setPendingAction(undefined);
            vscode.setState(message.state);
        };
        window.addEventListener('message', handleMessage);
        postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', handleMessage);
    }, []);
    const readyState = (0, hooks_1.useMemo)(() => ((0, helpers_1.isReadyState)(state) ? state : undefined), [state]);
    const activeProfile = readyState ? (0, helpers_1.getActiveProfile)(readyState) : undefined;
    const compareProfile = readyState ? (0, helpers_1.getCompareProfile)(readyState) ?? activeProfile : undefined;
    if (!state) {
        return <div class="app-shell">{(0, helpers_1.renderEmptyMessage)('Loading dashboard', 'Waiting for profile and usage state from the extension host.')}</div>;
    }
    if (state.kind === 'empty') {
        return (<div class="app-shell">
        <section class="empty-shell">
          <div class="section-kicker">Codex Usage</div>
          <h1>{state.title}</h1>
          <p>{state.message}</p>
        </section>
      </div>);
    }
    if (!activeProfile || !compareProfile) {
        return <div class="app-shell">{(0, helpers_1.renderEmptyMessage)('Dashboard unavailable', 'The active or compare profile could not be resolved from the latest state payload.')}</div>;
    }
    return (<div class="app-shell">
      <header_1.DashboardHeader state={state} pendingAction={pendingAction} onRefresh={() => {
            setPendingAction('refresh');
            postMessage({ type: 'refreshUsage' });
        }} onHistoryRangeChange={(value) => {
            setPendingAction(`range:${value}`);
            postMessage({ type: 'setHistoryRange', historyRange: value });
        }} onCompareChange={(profileId) => {
            setPendingAction(`compare:${profileId}`);
            postMessage({ type: 'setCompareProfile', profileId });
        }}/>

      <overview_1.OverviewSection state={state} profile={activeProfile}/>

      <profile_grid_1.ProfileGrid state={state} pendingAction={pendingAction} onCompareChange={(profileId) => {
            setPendingAction(`compare:${profileId}`);
            postMessage({ type: 'setCompareProfile', profileId });
        }} onSwitchProfile={(profileId) => {
            setPendingAction(`switch:${profileId}`);
            postMessage({ type: 'switchProfile', profileId });
        }}/>

      <section class="analytics-section">
        <div class="section-header">
          <div>
            <div class="section-kicker">Usage Analytics</div>
            <h2>Current and compare views with preserved history detail</h2>
          </div>
        </div>
        <div class="analytics-grid">
          <analytics_panel_1.AnalyticsPanel state={state} profile={activeProfile} roleLabel="Current" roleTone="active"/>
          <analytics_panel_1.AnalyticsPanel state={state} profile={compareProfile} roleLabel={compareProfile.id === activeProfile.id ? 'Same Profile' : 'Compare'} roleTone="compare" headerAction={!compareProfile.isActive ? (<button type="button" class="button button--ghost" onClick={() => {
                setPendingAction(`switch:${compareProfile.id}`);
                postMessage({ type: 'switchProfile', profileId: compareProfile.id });
            }} disabled={pendingAction === `switch:${compareProfile.id}`}>
                {pendingAction === `switch:${compareProfile.id}` ? 'Switching…' : 'Switch to This Profile'}
              </button>) : undefined}/>
        </div>
      </section>
    </div>);
}
//# sourceMappingURL=app.js.map
