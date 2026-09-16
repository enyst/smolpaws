import assert from 'node:assert/strict';
import test from 'node:test';

import pino from 'pino';

import { STARTUP_NOTICE, StartupNotice } from './startupNotice.js';

test('startup announcements coalesce concurrent readiness and reconnects, once per destination', async () => {
  const notice = new StartupNotice(pino({ level: 'silent' }));
  const sent: Array<{ id: string; text: string }> = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const send = async (id: string, text: string) => {
    sent.push({ id, text });
    await pending;
  };

  const first = notice.notify(['main', ' main ', '', ' ', 'group'], send);
  assert.equal(notice.notify(['main', 'group'], send), first);
  await Promise.resolve();
  assert.deepEqual(sent, [{ id: 'main', text: STARTUP_NOTICE }, { id: 'group', text: STARTUP_NOTICE }]);
  release();
  await first;

  // The same process reconnecting must not announce itself again or discover new recipients.
  assert.equal(notice.notify(['main', 'group', 'later'], send), first);
  await notice.notify(['main'], send);
  assert.equal(sent.length, 2);

  // A fresh bridge process owns a new notifier and announces its new start.
  await new StartupNotice(pino({ level: 'silent' })).notify(['main'], send);
  assert.deepEqual(sent.at(-1), { id: 'main', text: "🐾 I'm up." });
  assert.equal(sent.length, 3);
});

test('a failed startup send does not prevent other destinations or retry an uncertain send', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const logger = pino({ base: null, timestamp: false }, {
    write(line: string) { logs.push(JSON.parse(line) as Record<string, unknown>); },
  });
  const notice = new StartupNotice(logger);
  const attempted: string[] = [];
  const send = async (id: string) => {
    attempted.push(id);
    if (id === 'unavailable') throw new Error('connection closed');
  };

  await notice.notify(['unavailable', 'main', 'group'], send);
  assert.deepEqual(attempted, ['unavailable', 'main', 'group']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.targetId, 'unavailable');
  assert.equal(logs[0]?.err, 'connection closed');
  assert.equal(logs[0]?.msg, 'Bridge startup notification failed');
  await notice.notify(['unavailable'], send);
  assert.equal(attempted.length, 3);
});

test('no configured destinations produces no announcement', async () => {
  let sends = 0;
  const notice = new StartupNotice(pino({ level: 'silent' }));
  await notice.notify([], async () => { sends += 1; });
  assert.equal(sends, 0);
});
