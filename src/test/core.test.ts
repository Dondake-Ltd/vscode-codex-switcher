import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  expandPath,
  getActiveAuthPath,
  getBackupPath,
  getEnabledAccounts,
  getTimestamp,
  normalizeAccounts,
  resolveCodexHome,
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
