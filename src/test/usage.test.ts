import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getSessionsPath, readLatestUsageSnapshot } from '../usage';

async function makeTempCodexHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codex-switcher-usage-'));
}

test('getSessionsPath points at the sessions directory', () => {
  assert.equal(getSessionsPath('/tmp/codex'), path.join('/tmp/codex', 'sessions'));
});

test('readLatestUsageSnapshot returns the newest token_count event', async () => {
  const codexHome = await makeTempCodexHome();
  const dayPath = path.join(getSessionsPath(codexHome), '2026', '04', '02');
  await fs.mkdir(dayPath, { recursive: true });

  const sessionPath = path.join(dayPath, 'rollout-a.jsonl');
  await fs.writeFile(
    sessionPath,
    [
      JSON.stringify({ timestamp: '2026-04-02T10:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message' } }),
      JSON.stringify({
        timestamp: '2026-04-02T10:05:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 25, window_minutes: 300, resets_at: 1775124300 },
            secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1775729100 },
            plan_type: 'plus',
            limit_id: 'example-limit'
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-04-02T10:10:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 35.5, window_minutes: 300, resets_at: 1775125200 },
            secondary: { used_percent: 15, window_minutes: 10080, resets_at: 1775730000 }
          }
        }
      })
    ].join('\n'),
    'utf8'
  );

  const snapshot = await readLatestUsageSnapshot(codexHome);
  assert.ok(snapshot);
  assert.equal(snapshot.recordedAt, '2026-04-02T10:10:00.000Z');
  assert.equal(snapshot.primary?.usedPercent, 35.5);
  assert.equal(snapshot.primary?.windowMinutes, 300);
  assert.equal(snapshot.secondary?.usedPercent, 15);
  assert.equal(snapshot.sourceFile, sessionPath);
});

test('readLatestUsageSnapshot prefers the newest modified session file', async () => {
  const codexHome = await makeTempCodexHome();
  const sessionsPath = getSessionsPath(codexHome);
  const olderDay = path.join(sessionsPath, '2026', '04', '01');
  const newerDay = path.join(sessionsPath, '2026', '04', '02');
  await fs.mkdir(olderDay, { recursive: true });
  await fs.mkdir(newerDay, { recursive: true });

  const olderFile = path.join(olderDay, 'rollout-old.jsonl');
  const newerFile = path.join(newerDay, 'rollout-new.jsonl');

  await fs.writeFile(
    olderFile,
    JSON.stringify({
      timestamp: '2026-04-01T09:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 50, window_minutes: 300, resets_at: 1775038800 }
        }
      }
    }),
    'utf8'
  );
  await fs.writeFile(
    newerFile,
    JSON.stringify({
      timestamp: '2026-04-02T09:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 5, window_minutes: 300, resets_at: 1775125200 }
        }
      }
    }),
    'utf8'
  );

  const now = new Date();
  const later = new Date(now.getTime() + 10_000);
  await fs.utimes(olderFile, now, now);
  await fs.utimes(newerFile, later, later);

  const snapshot = await readLatestUsageSnapshot(codexHome);
  assert.ok(snapshot);
  assert.equal(snapshot.sourceFile, newerFile);
  assert.equal(snapshot.primary?.usedPercent, 5);
});

test('readLatestUsageSnapshot returns undefined when there is no token_count event', async () => {
  const codexHome = await makeTempCodexHome();
  const dayPath = path.join(getSessionsPath(codexHome), '2026', '04', '02');
  await fs.mkdir(dayPath, { recursive: true });

  await fs.writeFile(
    path.join(dayPath, 'rollout-empty.jsonl'),
    JSON.stringify({ timestamp: '2026-04-02T10:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message' } }),
    'utf8'
  );

  const snapshot = await readLatestUsageSnapshot(codexHome);
  assert.equal(snapshot, undefined);
});
