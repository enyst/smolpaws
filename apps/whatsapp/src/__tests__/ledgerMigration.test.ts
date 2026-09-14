import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { WhatsAppLedger } from '../ledger.js';

test('a legacy ledger without seq is numbered in insertion order and keeps numbering for any writer', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsapp-ledger-'));
  const file = path.join(root, 'messages.db');
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT,
      is_from_me INTEGER, media_path TEXT, media_type TEXT, PRIMARY KEY (id, chat_jid)
    );
    INSERT INTO messages VALUES ('L2', 'c', 's', 'S', 'second', '2026-01-01T00:00:01Z', 0, NULL, NULL);
    INSERT INTO messages VALUES ('L1', 'c', 's', 'S', 'first', '2026-01-01T00:00:00Z', 0, NULL, NULL);
  `);
  legacy.close();

  try {
    const ledger = new WhatsAppLedger(file);
    try {
      assert.deepEqual(ledger.getNewMessages(['c'], 0, 'smolpaws').map((m) => [m.id, m.seq]), [['L2', 1], ['L1', 2]]);
      // A writer that knows nothing about seq (legacy runtime) still gets numbered by the trigger.
      ledger.db
        .prepare(`INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES ('L3', 'c', 's', 'S', 'third', '2026-01-01T00:00:00Z', 0)`)
        .run();
      ledger.storeMessage({ id: 'L4', chatJid: 'c', sender: 's', senderName: 'S', content: 'fourth', timestamp: '2026-01-01T00:00:00Z', isFromMe: false });
      assert.deepEqual(ledger.getNewMessages(['c'], 2, 'smolpaws').map((m) => [m.id, m.seq]), [['L3', 3], ['L4', 4]]);
    } finally {
      ledger.close();
    }
    // Reopening never renumbers.
    const again = new WhatsAppLedger(file);
    try {
      assert.deepEqual(again.getNewMessages(['c'], 0, 'smolpaws').map((m) => m.seq), [1, 2, 3, 4]);
    } finally {
      again.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
