import assert from 'node:assert/strict';
import test from 'node:test';

import type { LaneRow } from '../../../../src/coordinator/types.js';
import { WHATSAPP_MAX_LENGTH, WhatsAppDeliveryTarget, splitWhatsAppMessage } from '../deliveryTarget.js';
import { WhatsAppLedger } from '../ledger.js';

const lane: LaneRow = {
  laneKey: 'whatsapp:1:123@g.us',
  conversationId: 'c1',
  platform: 'whatsapp',
  accountId: '1',
  chatId: '123@g.us',
  threadId: null,
  displayName: null,
  conversationReady: true,
  createdAt: '2026-09-13T00:00:00.000Z',
  lastSeenAt: '2026-09-13T00:00:00.000Z',
};

test('ledger stores messages, filters the cat\'s own prefixed replies, and keeps sequence cursors', () => {
  const ledger = new WhatsAppLedger(':memory:');
  try {
    ledger.touchChat('123@g.us', '2026-09-13T10:00:00.000Z');
    ledger.storeMessage({ id: 'M1', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'hi', timestamp: '2026-09-13T10:00:00.000Z', isFromMe: false });
    ledger.storeMessage({ id: 'M2', chatJid: '123@g.us', sender: 'me', senderName: 'me', content: 'smolpaws: I replied', timestamp: '2026-09-13T10:00:01.000Z', isFromMe: true });
    ledger.storeMessage({ id: 'M3', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'thanks', timestamp: '2026-09-13T10:00:02.000Z', isFromMe: false });
    // A replayed id updates in place and keeps its ingestion sequence.
    ledger.storeMessage({ id: 'M1', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'hi (edited)', timestamp: '2026-09-13T10:00:00.000Z', isFromMe: false });

    const fresh = ledger.getNewMessages(['123@g.us'], 0, 'smolpaws');
    assert.deepEqual(fresh.map((m) => m.id), ['M1', 'M3']);
    assert.deepEqual(fresh.map((m) => m.content), ['hi (edited)', 'thanks']);
    assert.deepEqual(fresh.map((m) => m.seq), [1, 3]);
    assert.deepEqual(ledger.getMessagesSince('123@g.us', 1, 'smolpaws').map((m) => m.content), ['thanks']);
    assert.deepEqual(ledger.getNewMessages([], 0, 'smolpaws'), []);

    assert.equal(ledger.getDispatchSeq('123@g.us'), 0);
    ledger.setDispatchSeq('123@g.us', 3);
    ledger.setDispatchSeq('123@g.us', 1); // never moves backwards
    assert.equal(ledger.getDispatchSeq('123@g.us'), 3);
    assert.equal(ledger.getLastAgentSeq('123@g.us'), 0);
    ledger.setLastAgentSeq('123@g.us', 3);
    assert.equal(ledger.getLastAgentSeq('123@g.us'), 3);
  } finally {
    ledger.close();
  }
});

test('a message sharing the second of an already-dispatched one is still dispatched', () => {
  const ledger = new WhatsAppLedger(':memory:');
  try {
    const sameSecond = '2026-09-13T10:00:00.000Z';
    ledger.storeMessage({ id: 'M1', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'first', timestamp: sameSecond, isFromMe: false });
    const [m1] = ledger.getNewMessages(['123@g.us'], ledger.getDispatchSeq('123@g.us'), 'smolpaws');
    assert.equal(m1?.id, 'M1');
    ledger.setDispatchSeq('123@g.us', m1!.seq);

    // Arrives later (offline sync / same-second burst) but carries the same WhatsApp timestamp.
    ledger.storeMessage({ id: 'M2', chatJid: '123@g.us', sender: 'b', senderName: 'B', content: 'second', timestamp: sameSecond, isFromMe: false });
    const pending = ledger.getNewMessages(['123@g.us'], ledger.getDispatchSeq('123@g.us'), 'smolpaws');
    assert.deepEqual(pending.map((m) => m.id), ['M2']);
    ledger.setDispatchSeq('123@g.us', pending[0]!.seq);
    assert.deepEqual(ledger.getNewMessages(['123@g.us'], ledger.getDispatchSeq('123@g.us'), 'smolpaws'), []);
  } finally {
    ledger.close();
  }
});

test('legacy timestamp cursors are converted once to sequence cursors', () => {
  const ledger = new WhatsAppLedger(':memory:');
  try {
    ledger.storeMessage({ id: 'M1', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'old', timestamp: '2026-09-13T10:00:00.000Z', isFromMe: false });
    ledger.storeMessage({ id: 'M2', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'new', timestamp: '2026-09-13T10:00:05.000Z', isFromMe: false });
    ledger.storeMessage({ id: 'M3', chatJid: '456@g.us', sender: 'a', senderName: 'A', content: 'other chat', timestamp: '2026-09-13T10:00:00.000Z', isFromMe: false });
    ledger.setState('dispatch_cursor', '2026-09-13T10:00:00.000Z');
    ledger.setState('last_agent_ts:123@g.us', '2026-09-13T10:00:00.000Z');

    assert.equal(ledger.getDispatchSeq('123@g.us'), 1);
    assert.deepEqual(ledger.getNewMessages(['123@g.us'], ledger.getDispatchSeq('123@g.us'), 'smolpaws').map((m) => m.id), ['M2']);
    assert.equal(ledger.getLastAgentSeq('123@g.us'), 1);
    assert.equal(ledger.getDispatchSeq('456@g.us'), 3);
    // Converted once: the seq cursor now owns the state even if the legacy key changes.
    ledger.setState('dispatch_cursor', '2026-09-13T11:00:00.000Z');
    assert.equal(ledger.getDispatchSeq('123@g.us'), 1);
  } finally {
    ledger.close();
  }
});

test('delivery target prefixes the assistant name, splits long text, and returns the last message id', async () => {
  const sent: Array<{ jid: string; text: string }> = [];
  let counter = 0;
  const target = new WhatsAppDeliveryTarget(async (jid, text) => {
    sent.push({ jid, text });
    counter += 1;
    return `WA${counter}`;
  }, 'smolpaws');

  target.validate(lane, { kind: 'current_thread_message', text: 'hello' });
  assert.throws(() => target.validate({ ...lane, platform: 'slack' }, { kind: 'current_thread_message', text: 'x' }));
  assert.throws(() => target.validate(lane, { kind: 'current_thread_message', text: '   ' }));
  assert.throws(() => target.validate(lane, { kind: 'other', text: 'x' }));

  const result = await target.deliver(lane, { kind: 'current_thread_message', text: 'hello there' });
  assert.deepEqual(result, { externalMessageId: 'WA1' });
  assert.deepEqual(sent, [{ jid: '123@g.us', text: 'smolpaws: hello there' }]);

  const long = 'word '.repeat(WHATSAPP_MAX_LENGTH / 2);
  const chunks = splitWhatsAppMessage(long);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= WHATSAPP_MAX_LENGTH));
  const longResult = await target.deliver(lane, { kind: 'current_thread_message', text: long });
  assert.equal(longResult.externalMessageId, `WA${1 + chunks.length}`);
  assert.ok(sent[1]?.text.startsWith('smolpaws: word'));
  assert.ok(sent[2]?.text.startsWith('smolpaws: …'));
});

test('delivery target reports readiness from the transport', () => {
  let connected = false;
  const target = new WhatsAppDeliveryTarget(async () => 'x', 'smolpaws', () => connected);
  assert.equal(target.isReady(), false);
  connected = true;
  assert.equal(target.isReady(), true);
  assert.equal(new WhatsAppDeliveryTarget(async () => 'x', 'smolpaws').isReady(), true);
});
