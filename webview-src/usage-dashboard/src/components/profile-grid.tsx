import { h } from 'preact';
import type { UsageDashboardReadyState, UsagePanelProfile } from '../../../../src/usageDashboardTypes';
import {
  formatDisplayPercent,
  getDisplayPercentValue,
  getSeverityTone,
  getUsageWindowDescriptors,
  joinNonEmpty
} from '../helpers';

type ProfileGridProps = {
  state: UsageDashboardReadyState;
  onCompareChange: (profileId: string) => void;
  onSwitchProfile: (profileId: string) => void;
  pendingAction: string | undefined;
};

function ProfileUsageMiniRow(props: {
  state: UsageDashboardReadyState;
  profile: UsagePanelProfile;
  descriptor: ReturnType<typeof getUsageWindowDescriptors>[number];
}) {
  const { descriptor, state } = props;
  const tone = getSeverityTone(descriptor.window, state.warningThreshold, state.criticalThreshold);
  const percent = getDisplayPercentValue(descriptor.window, state.percentDisplayMode);

  return (
    <div class="profile-card__metric">
      <div class="profile-card__metric-head">
        <span>{descriptor.shortLabel}</span>
        <strong>{formatDisplayPercent(descriptor.window, state.percentDisplayMode)}</strong>
      </div>
      <div class="linear-meter">
        <div class={`linear-meter__fill linear-meter__fill--${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function ProfileGrid(props: ProfileGridProps) {
  return (
    <section class="profile-grid-section">
      <div class="section-header">
        <div>
          <div class="section-kicker">Saved Profiles</div>
          <h2>Dashboard cards for every saved Codex profile</h2>
        </div>
      </div>
      <div class="profile-grid">
        {props.state.profiles.map((profile) => {
          const descriptors = getUsageWindowDescriptors(profile.snapshot);
          const subtitle = joinNonEmpty([
            profile.email && profile.email !== 'Unknown' ? profile.email : undefined,
            profile.planType && profile.planType !== 'Unknown' ? profile.planType : undefined
          ]);
          const isCompare = profile.id === props.state.compareProfileId;
          const switchAction = `switch:${profile.id}`;

          return (
            <article class={`profile-card ${profile.isActive ? 'profile-card--active' : ''} ${isCompare ? 'profile-card--compare' : ''}`} key={profile.id}>
              <div class="profile-card__header">
                <div>
                  <h3>{profile.name}</h3>
                  <p>{subtitle || 'No profile metadata'}</p>
                </div>
                <div class="profile-card__chips">
                  {profile.isActive ? <span class="badge badge--active">Current</span> : null}
                  {isCompare ? <span class="badge badge--compare">Compare</span> : null}
                  {profile.isStale ? <span class="badge badge--warning">Stale</span> : <span class="badge badge--healthy">Healthy</span>}
                </div>
              </div>
              <div class="profile-card__body">
                {descriptors.length
                  ? descriptors.map((descriptor) => (
                      <ProfileUsageMiniRow key={descriptor.longLabel} state={props.state} profile={profile} descriptor={descriptor} />
                    ))
                  : <div class="profile-card__empty">No live usage cached yet.</div>}
              </div>
              <div class="profile-card__meta">
                <span>{profile.sourceLabel}</span>
                <span>{profile.updatedLabel}</span>
              </div>
              <div class="profile-card__actions">
                {!profile.isActive ? (
                  <button
                    type="button"
                    class="button button--ghost"
                    onClick={() => props.onSwitchProfile(profile.id)}
                    disabled={props.pendingAction === switchAction}
                  >
                    {props.pendingAction === switchAction ? 'Switching…' : 'Switch'}
                  </button>
                ) : <span class="profile-card__action-placeholder">Active profile</span>}
                {!profile.isActive ? (
                  <button type="button" class="button button--secondary" onClick={() => props.onCompareChange(profile.id)}>
                    {isCompare ? 'Comparing' : 'Compare'}
                  </button>
                ) : (
                  <button type="button" class="button button--secondary" disabled>
                    Current
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
