import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { App } from '@slack/bolt';
import Database from 'better-sqlite3';
import pino from 'pino';

import { SlackBridge } from '../adapter.js';
import { loadConfig } from '../config.js';

class FakeApp {
  readonly sent: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  readonly failedChannels = new Set<string>();
  readonly attempted: string[] = [];
  teamId: string | undefined = 'T1';
  ready: Promise<void> = Promise.resolve();
  startCalled = false;
  client = {
    auth: { test: async () => ({ user_id: 'B1', team_id: this.teamId, team: 'Test team' }) },
    chat: {
      postMessage: async (message: { channel: string; text: string; thread_ts?: string }) => {
        this.attempted.push(message.channel);
        if (this.failedChannels.has(message.channel)) throw new Error('Channel unavailable');
        this.sent.push(message);
        return { ts: `1.${this.sent.length}` };
      },
    },
  };
  event(): void {}
  async start(): Promise<void> {
    this.startCalled = true;
    await this.ready;
  }
  async stop(): Promise<void> {}
}

function makeBridge(root: string, app: FakeApp, env: Record<string, string | undefined> = {}) {
  return new SlackBridge({
    logger: pino({ level: 'silent' }),
    serverUrl: 'http://127.0.0.1:1',
    slackConfig: loadConfig({ SLACK_BOT_TOKEN: 'test', SLACK_APP_TOKEN: 'test', ...env }),
    dbPath: path.join(root, 'relay.db'),
    tickMs: 60_000,
    appFactory: () => app as unknown as App,
  });
}

test('Slack startup notice waits for Socket Mode readiness and posts once per configured channel at its root', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'slack-startup-'));
  const app = new FakeApp();
  let ready!: () => void;
  app.ready = new Promise<void>((resolve) => { ready = resolve; });
  const bridge = makeBridge(root, app, { SLACK_ALLOWED_CHANNEL_IDS: 'C1, C2, C1', SLACK_ALLOWED_TEAM_IDS: 'T1' });
  try {
    const starting = bridge.start();
    while (!app.startCalled) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(app.sent, []);
    ready();
    await starting;
    assert.deepEqual(app.sent.map(({ channel, text, thread_ts }) => ({ channel, text, thread_ts })), [
      { channel: 'C1', text: "🐾 I'm up.", thread_ts: undefined },
      { channel: 'C2', text: "🐾 I'm up.", thread_ts: undefined },
    ]);
    await bridge.start();
    await bridge.stop();
    await bridge.start();
    assert.equal(app.sent.length, 2, 'repeated readiness in one bridge process must not reannounce');
    const db = new Database(path.join(root, 'relay.db'), { readonly: true });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM work').get() as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM lanes').get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  } finally {
    ready();
    await bridge.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Slack startup notice respects opt-out, explicit targets, and authenticated team restrictions', async () => {
  for (const env of [
    {},
    { SLACK_ALLOWED_CHANNEL_IDS: 'C1', SMOLPAWS_SLACK_STARTUP_PING: '0' },
    { SLACK_ALLOWED_CHANNEL_IDS: 'C1', SLACK_ALLOWED_TEAM_IDS: 'T2' },
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), 'slack-startup-filter-'));
    const app = new FakeApp();
    const bridge = makeBridge(root, app, env);
    try {
      await bridge.start();
      assert.equal(bridge.connected, true);
      assert.deepEqual(app.attempted, []);
    } finally {
      await bridge.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.equal(loadConfig({ SLACK_BOT_TOKEN: 'test', SLACK_APP_TOKEN: 'test' }).startupPing, true);
});

test('Slack notice failure does not stop startup or suppress other configured channels', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'slack-startup-failure-'));
  const app = new FakeApp();
  app.failedChannels.add('C1');
  const bridge = makeBridge(root, app, { SLACK_ALLOWED_CHANNEL_IDS: 'C1,C2' });
  try {
    await bridge.start();
    assert.equal(bridge.connected, true);
    assert.deepEqual(app.attempted, ['C1', 'C2']);
    assert.deepEqual(app.sent.map(({ channel }) => channel), ['C2']);
    await bridge.stop();
    await bridge.start();
    assert.deepEqual(app.attempted, ['C1', 'C2'], 'ambiguous sends must not be retried');
  } finally {
    await bridge.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Slack startup destinations can be configured without narrowing ingress, but cannot bypass its filters', async () => {
  for (const { env, expected } of [
    { env: { SMOLPAWS_SLACK_STARTUP_CHANNEL_IDS: 'C1,C2' }, expected: ['C1', 'C2'] },
    { env: { SMOLPAWS_SLACK_STARTUP_CHANNEL_IDS: 'C1,C2', SLACK_ALLOWED_CHANNEL_IDS: 'C2,C3' }, expected: ['C2'] },
    { env: { SMOLPAWS_SLACK_STARTUP_CHANNEL_IDS: '', SLACK_ALLOWED_CHANNEL_IDS: 'C1' }, expected: [] },
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), 'slack-startup-targets-'));
    const app = new FakeApp();
    const bridge = makeBridge(root, app, env);
    try {
      await bridge.start();
      assert.deepEqual(app.sent.map(({ channel }) => channel), expected);
    } finally {
      await bridge.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
