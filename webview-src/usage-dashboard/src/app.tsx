import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type {
  UsageDashboardFromWebviewMessage,
  UsageDashboardReadyState,
  UsageDashboardState
} from '../../../src/usageDashboardTypes';
import { DashboardHeader } from './components/header';
import { OverviewSection } from './components/overview';
import { ProfileGrid } from './components/profile-grid';
import { AnalyticsPanel } from './components/analytics-panel';
import { getActiveProfile, getCompareProfile, isReadyState, renderEmptyMessage } from './helpers';
import { getVsCodeApi } from './vscode';

const vscode = getVsCodeApi();

function postMessage(message: UsageDashboardFromWebviewMessage): void {
  vscode.postMessage(message);
}

export function App() {
  const [state, setState] = useState<UsageDashboardState | undefined>(() => vscode.getState() as UsageDashboardState | undefined);
  const [pendingAction, setPendingAction] = useState<string>();

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; state?: UsageDashboardState };
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

  const readyState = useMemo(() => (isReadyState(state) ? state : undefined), [state]);
  const activeProfile = readyState ? getActiveProfile(readyState) : undefined;
  const compareProfile = readyState ? getCompareProfile(readyState) ?? activeProfile : undefined;

  if (!state) {
    return <div class="app-shell">{renderEmptyMessage('Loading dashboard', 'Waiting for profile and usage state from the extension host.')}</div>;
  }

  if (state.kind === 'empty') {
    return (
      <div class="app-shell">
        <section class="empty-shell">
          <div class="section-kicker">Codex Usage</div>
          <h1>{state.title}</h1>
          <p>{state.message}</p>
        </section>
      </div>
    );
  }

  if (!activeProfile || !compareProfile) {
    return <div class="app-shell">{renderEmptyMessage('Dashboard unavailable', 'The active or compare profile could not be resolved from the latest state payload.')}</div>;
  }

  return (
    <div class="app-shell">
      <DashboardHeader
        state={state}
        pendingAction={pendingAction}
        onRefresh={() => {
          setPendingAction('refresh');
          postMessage({ type: 'refreshUsage' });
        }}
        onHistoryRangeChange={(value) => {
          setPendingAction(`range:${value}`);
          postMessage({ type: 'setHistoryRange', historyRange: value });
        }}
        onCompareChange={(profileId) => {
          setPendingAction(`compare:${profileId}`);
          postMessage({ type: 'setCompareProfile', profileId });
        }}
      />

      <OverviewSection state={state} profile={activeProfile} />

      <ProfileGrid
        state={state}
        pendingAction={pendingAction}
        onCompareChange={(profileId) => {
          setPendingAction(`compare:${profileId}`);
          postMessage({ type: 'setCompareProfile', profileId });
        }}
        onSwitchProfile={(profileId) => {
          setPendingAction(`switch:${profileId}`);
          postMessage({ type: 'switchProfile', profileId });
        }}
      />

      <section class="analytics-section">
        <div class="section-header">
          <div>
            <div class="section-kicker">Usage Analytics</div>
            <h2>Current and compare views with preserved history detail</h2>
          </div>
        </div>
        <div class="analytics-grid">
          <AnalyticsPanel
            state={state}
            profile={activeProfile}
            roleLabel="Current"
            roleTone="active"
          />
          <AnalyticsPanel
            state={state}
            profile={compareProfile}
            roleLabel={compareProfile.id === activeProfile.id ? 'Same Profile' : 'Compare'}
            roleTone="compare"
            headerAction={!compareProfile.isActive ? (
              <button
                type="button"
                class="button button--ghost"
                onClick={() => {
                  setPendingAction(`switch:${compareProfile.id}`);
                  postMessage({ type: 'switchProfile', profileId: compareProfile.id });
                }}
                disabled={pendingAction === `switch:${compareProfile.id}`}
              >
                {pendingAction === `switch:${compareProfile.id}` ? 'Switching…' : 'Switch to This Profile'}
              </button>
            ) : undefined}
          />
        </div>
      </section>
    </div>
  );
}
