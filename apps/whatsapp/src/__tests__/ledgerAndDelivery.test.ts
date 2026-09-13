import assert from 'node:assert/strict';
import test from 'node:test';

import type { LaneRow } from '../../../../src/coordinator/types.js';
import { WHATSAPP_MAX_LENGTH, WhatsAppDeliveryTarget, splitWhatsAppMessage } from '../deliveryTarget.js';
import { WhatsAppLedger } from '../ledger.js';

const lane: LaneRow = {
  laneKey: 'channel:whatsapp:1:123@g.us:root',
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

test('ledger stores messages, filters the cat\'s own prefixed replies, and keeps cursors', () => {
  const ledger = new WhatsAppLedger(':memory:');
  try {
    ledger.touchChat('123@g.us', '2026-09-13T10:00:00.000Z');
    ledger.storeMessage({ id: 'M1', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'hi', timestamp: '2026-09-13T10:00:00.000Z', isFromMe: false });
    ledger.storeMessage({ id: 'M2', chatJid: '123@g.us', sender: 'me', senderName: 'me', content: 'smolpaws: I replied', timestamp: '2026-09-13T10:00:01.000Z', isFromMe: true });
    ledger.storeMessage({ id: 'M3', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'thanks', timestamp: '2026-09-13T10:00:02.000Z', isFromMe: false });
    ledger.storeMessage({ id: 'M1', chatJid: '123@g.us', sender: 'a', senderName: 'A', content: 'hi (edited)', timestamp: '2026-09-13T10:00:00.000Z', isFromMe: false });

    assert.deepEqual(ledger.getNewMessages(['123@g.us'], '', 'smolpaws').map((m) => m.id), ['M1', 'M3']);
    assert.deepEqual(ledger.getMessagesSince('123@g.us', '2026-09-13T10:00:00.000Z', 'smolpaws').map((m) => m.content), ['thanks']);
    assert.deepEqual(ledger.getNewMessages([], '', 'smolpaws'), []);

    assert.equal(ledger.getDispatchCursor(), '');
    ledger.setDispatchCursor('2026-09-13T10:00:02.000Z');
    ledger.setDispatchCursor('2026-09-13T09:00:00.000Z');
    assert.equal(ledger.getDispatchCursor(), '2026-09-13T10:00:02.000Z');
    assert.equal(ledger.getLastAgentTimestamp('123@g.us'), '');
    ledger.setLastAgentTimestamp('123@g.us', '2026-09-13T10:00:02.000Z');
    assert.equal(ledger.getLastAgentTimestamp('123@g.us'), '2026-09-13T10:00:02.000Z');
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
