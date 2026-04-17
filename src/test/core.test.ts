import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  expandPath,
  getActiveAuthPath,
  getImportProfileActivationDecision,
  getBackupPath,
  getEnabledAccounts,
  getMinimumRemainingPercentForWindows,
  getTimestamp,
  getWorkspaceProfileSwitchPromptDecision,
  normalizeAccounts,
  pickLowUsageCandidate,
  resolveCodexHome,
  shouldOfferRememberWorkspaceProfile,
  shouldActivateImportedProfile,
  validateJsonObjectText
} from '../core';

test('normalizeAccounts keeps only valid account objects', () => {
  const accounts = normalizeAccounts([
    { name: 'Personal', authFile: '/tmp/a.json', enabled: true },
    { name: 'MissingAuth' },
    null,
    { name: 'Work', authFile: '/tmp/b.json' }
  ]);

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].name, 'Personal');
  assert.equal(accounts[1].name, 'Work');
});

test('getEnabledAccounts filters disabled accounts', () => {
  const enabled = getEnabledAccounts([
    { name: 'Personal', authFile: 'a.json', enabled: true },
    { name: 'Work', authFile: 'b.json', enabled: false },
    { name: 'Team', authFile: 'c.json' }
  ]);

  assert.deepEqual(
    enabled.map((a) => a.name),
    ['Personal', 'Team']
  );
});

test('shouldActivateImportedProfile only activates when there is no active profile or the imported profile is already active', () => {
  assert.equal(shouldActivateImportedProfile(undefined, 'profile-a'), true);
  assert.equal(shouldActivateImportedProfile('profile-a', 'profile-a'), true);
  assert.equal(shouldActivateImportedProfile('profile-a', 'profile-b'), false);
});

test('getImportProfileActivationDecision respects import switch behavior', () => {
  assert.equal(getImportProfileActivationDecision(undefined, 'profile-a', 'ask'), 'ask');
  assert.equal(getImportProfileActivationDecision('profile-a', 'profile-a', 'always'), 'keep');
  assert.equal(getImportProfileActivationDecision('profile-a', 'profile-b', 'always'), 'keep');
  assert.equal(getImportProfileActivationDecision(undefined, 'profile-a', 'always'), 'activate');
  assert.equal(getImportProfileActivationDecision(undefined, 'profile-a', 'never'), 'keep');
});

test('getMinimumRemainingPercentForWindows ignores outdated windows and uses the smallest remaining value', () => {
  const now = Date.parse('2026-04-17T18:00:00.000Z');

  assert.equal(
    getMinimumRemainingPercentForWindows([
      { usedPercent: 20, resetsAt: '2026-04-17T19:00:00.000Z' },
      { usedPercent: 65, resetsAt: '2026-04-17T21:00:00.000Z' }
    ], now),
    35
  );

  assert.equal(
    getMinimumRemainingPercentForWindows([
      { usedPercent: 20, resetsAt: '2026-04-17T17:00:00.000Z' }
    ], now),
    undefined
  );
});

test('pickLowUsageCandidate chooses the freshest eligible best-capacity candidate', () => {
  const now = Date.parse('2026-04-17T18:00:00.000Z');
  const candidate = pickLowUsageCandidate(
    [
      { item: 'stale-high', recordedAt: '2026-04-17T17:40:00.000Z', remainingPercent: 90 },
      { item: 'fresh-low', recordedAt: '2026-04-17T17:55:00.000Z', remainingPercent: 12 },
      { item: 'fresh-best', recordedAt: '2026-04-17T17:58:00.000Z', remainingPercent: 60 },
      { item: 'fresh-too-low', recordedAt: '2026-04-17T17:59:00.000Z', remainingPercent: 5 }
    ],
    10,
    10 * 60 * 1000,
    now
  );

  assert.equal(candidate?.item, 'fresh-best');
});

test('resolveCodexHome uses configured path first', () => {
  const codexHome = resolveCodexHome({
    configuredCodexHome: '/custom/codex',
    envCodexHome: '/env/codex',
    homeDir: '/home/tester',
    platform: 'linux',
    envHome: '/home/tester'
  });

  assert.equal(codexHome, '/custom/codex');
});

test('resolveCodexHome uses env and default fallback', () => {
  const fromEnv = resolveCodexHome({
    envCodexHome: '/env/codex',
    homeDir: '/home/tester',
    platform: 'linux',
    envHome: '/home/tester'
  });
  assert.equal(fromEnv, '/env/codex');

  const fromDefault = resolveCodexHome({
    homeDir: '/home/tester',
    platform: 'linux',
    envHome: '/home/tester'
  });
  assert.equal(fromDefault, path.join('/home/tester', '.codex'));
});

test('expandPath resolves placeholders and relative paths', () => {
  const codexHome = '/home/tester/.codex';
  const p = expandPath('${codexHome}/auth.work.json', {
    codexHome,
    homeDir: '/home/tester',
    platform: 'linux',
    envHome: '/home/tester'
  });
  assert.equal(p.replaceAll('\\', '/'), '/home/tester/.codex/auth.work.json');

  const rel = expandPath('snapshots/work.json', {
    codexHome,
    homeDir: '/home/tester',
    platform: 'linux',
    envHome: '/home/tester'
  });
  assert.equal(rel.replaceAll('\\', '/'), path.resolve(codexHome, 'snapshots/work.json').replaceAll('\\', '/'));
});

test('validateJsonObjectText accepts object JSON and rejects invalid roots', () => {
  assert.equal(validateJsonObjectText('{\"token\":\"x\"}').valid, true);
  assert.equal(validateJsonObjectText('[1,2,3]').valid, false);
  assert.equal(validateJsonObjectText('not-json').valid, false);
});

test('timestamp and auth path helpers generate expected values', () => {
  const date = new Date('2026-01-02T03:04:05.678Z');
  const ts = getTimestamp(date);
  assert.equal(ts, '2026-01-02T03-04-05-678Z');

  assert.equal(getActiveAuthPath('/tmp/codex'), path.join('/tmp/codex', 'auth.json'));
  assert.equal(
    getBackupPath('/tmp/codex', ts),
    path.join('/tmp/codex', `auth.backup.${ts}.json`)
  );
});

test('getWorkspaceProfileSwitchPromptDecision only prompts when a mismatched preferred profile should be suggested', () => {
  assert.equal(
    getWorkspaceProfileSwitchPromptDecision({
      promptsEnabled: true,
      workspaceKey: 'repo:a',
      preferredProfileId: 'preferred',
      activeProfileId: 'active'
    }),
    'prompt'
  );

  assert.equal(
    getWorkspaceProfileSwitchPromptDecision({
      promptsEnabled: false,
      workspaceKey: 'repo:a',
      preferredProfileId: 'preferred',
      activeProfileId: 'active'
    }),
    'skip'
  );

  assert.equal(
    getWorkspaceProfileSwitchPromptDecision({
      promptsEnabled: true,
      workspaceKey: 'repo:a',
      preferredProfileId: 'preferred',
      activeProfileId: 'preferred'
    }),
    'skip'
  );

  assert.equal(
    getWorkspaceProfileSwitchPromptDecision({
      promptsEnabled: true,
      workspaceKey: 'repo:a',
      preferredProfileId: 'preferred',
      activeProfileId: 'active',
      suppressedForWorkspace: true
    }),
    'skip'
  );
});

test('shouldOfferRememberWorkspaceProfile only prompts when the workspace mapping should change', () => {
  assert.equal(
    shouldOfferRememberWorkspaceProfile({
      promptsEnabled: true,
      workspaceKey: 'repo:a',
      activeProfileId: 'active',
      preferredProfileId: 'preferred'
    }),
    true
  );

  assert.equal(
    shouldOfferRememberWorkspaceProfile({
      promptsEnabled: true,
      workspaceKey: 'repo:a',
      activeProfileId: 'active',
      preferredProfileId: 'active'
    }),
    false
  );

  assert.equal(
    shouldOfferRememberWorkspaceProfile({
      promptsEnabled: true,
      workspaceKey: 'repo:a',
      activeProfileId: 'active',
      preferredProfileId: 'preferred',
      alreadyPromptedThisSession: true
    }),
    false
  );
});
