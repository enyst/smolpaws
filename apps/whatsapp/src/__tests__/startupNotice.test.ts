import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import { WhatsAppBridge, type ConnectionUpdate, type WhatsAppSocketLike } from '../adapter.js';
import { loadConfig } from '../config.js';

test('each bridge start announces to every registered chat after readiness, without an agent run or reconnect echoes', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'wa-startup-notice-'));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Startup must not call the agent server'); });
  const sent: Array<{ jid: string; text: string }> = [];
  let connections = 0;
  let open: (update: ConnectionUpdate) => void = () => undefined;
  const config = { ...loadConfig({ SMOLPAWS_HOME_DIR: root }, root),
    registeredGroups: Object.fromEntries(['main', 'openhands', 'hunting'].map(folder =>
      [`${folder}@g.us`, { name: folder, folder, trigger: '@smolpaws', added_at: '2026-09-16' }])),
    pollIntervalMs: 60_000 };
  const make = (enabled = true) => new WhatsAppBridge({ logger: pino({ level: 'silent' }),
    serverUrl: 'http://127.0.0.1:1', config, startupPing: enabled, tickMs: 60_000,
    socketFactory: async () => { connections += 1; return { saveCreds() {}, socket: {
      user: { id: 'account@s.whatsapp.net' },
      ev: { on: ((event: string, callback: unknown) => {
        if (event === 'connection.update') open = callback as typeof open;
      }) as WhatsAppSocketLike['ev']['on'] },
      async sendMessage(jid, content) {
        sent.push({ jid, text: content.text ?? '' });
        return { key: { id: `notice-${sent.length}` } };
      },
      async sendPresenceUpdate() {},
      async groupFetchAllParticipating() { return {}; },
    } }; },
  });
  let bridge = make();
  try {
    await bridge.start();
    assert.equal(sent.length, 0, 'no notice before the transport opens');
    open({ connection: 'open' });
    await bridge.whenReady();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, ['main', 'openhands', 'hunting'].map(folder =>
      ({ jid: `${folder}@g.us`, text: "smolpaws: 🐾 I'm up." })));
    open({ connection: 'open' });
    open({ connection: 'open' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 3, 'repeated readiness does not repeat notices');
    open({ connection: 'close' });
    const deadline = Date.now() + 5_000;
    while (connections < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(connections, 2);
    open({ connection: 'open' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 3, 'a replacement socket does not repeat startup notices');
    await bridge.stop();
    bridge = make();
    await bridge.start();
    open({ connection: 'open' });
    await bridge.whenReady();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 6, 'a fresh bridge process announces again');
    await bridge.stop();
    bridge = make(false);
    await bridge.start();
    open({ connection: 'open' });
    await bridge.whenReady();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 6, 'explicit opt-out remains supported');
    assert.equal(fetch.mock.callCount(), 0, 'operational notice creates no agent request');
  } finally {
    await bridge.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
