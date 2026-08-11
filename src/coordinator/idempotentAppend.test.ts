/**
 * Proves option 2 closes the append-response-loss window against an agent-server that behaves like real
 * upstream: it IGNORES any caller-supplied `event_id`, assigns its own event id, and exposes
 * `/events/search` with a `body` substring filter over MessageEvent text only. No ADR §8 delta.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IdempotentIntakeAppender,
  idempotencyMarker,
  withMarker,
  type IdempotentAppendPort,
} from './idempotentAppend.js';
import { deterministicEventId } from './ids.js';

interface StoredEvent {
  id: string;
  kind: string;
  source: string;
  content: unknown[];
}

/** Concatenate the text of `{type:'text', text}` blocks — mirrors the SDK `content_to_str` the server's
 * `body` filter uses. */
function contentToText(content: unknown[]): string {
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join(' ');
}

/**
 * Upstream-accurate in-memory agent-server. Deliberately models the two behaviours that make this hard:
 *   - `append` ignores `event_id` and mints its own — a blind retry WOULD create a duplicate user turn.
 *   - `append` persists the event BEFORE it can fail, so a "lost response" leaves a durable event behind.
 */
class FakeUpstreamServer {
  readonly events: StoredEvent[] = [];
  private seq = 0;
  /** When set, the next append persists the event and THEN throws (simulates a lost HTTP response). */
  loseNextResponse = false;
  runRequests = 0;

  append(_conversationId: string, req: { role: string; content: unknown[]; run: boolean }): void {
    // Upstream builds Message(role, content) and assigns a fresh server-side id; event_id is not read.
    this.events.push({ id: `srv-${++this.seq}`, kind: 'MessageEvent', source: req.role, content: req.content });
    if (req.run) this.runRequests += 1;
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('simulated lost response after durable persist');
    }
  }

  search(filter: { kind?: string; source?: string; body?: string }): StoredEvent[] {
    const needle = filter.body?.toLowerCase();
    return this.events.filter(
      (e) =>
        (filter.kind === undefined || e.kind === filter.kind) &&
        (filter.source === undefined || e.source === filter.source) &&
        (needle === undefined || contentToText(e.content).toLowerCase().includes(needle)),
    );
  }

  userMessages(): StoredEvent[] {
    return this.events.filter((e) => e.kind === 'MessageEvent' && e.source === 'user');
  }
}

/** Port over the fake, matching exactly what a real REST client would do. */
function portFor(server: FakeUpstreamServer, conversationId: string): IdempotentAppendPort {
  return {
    async appendUserMessage(id, content, run) {
      server.append(id, { role: 'user', content, run });
    },
    async hasUserMessageWithMarker(id, marker) {
      assert.equal(id, conversationId);
      return server.search({ kind: 'MessageEvent', source: 'user', body: marker }).length > 0;
    },
    async run() {
      server.runRequests += 1;
    },
  };
}

test('normal append embeds a searchable marker and leaves the original text leading', async () => {
  const server = new FakeUpstreamServer();
  const conv = 'conv-1';
  const appender = new IdempotentIntakeAppender(portFor(server, conv));
  const eventId = deterministicEventId('whatsapp', 'msg-A');

  const res = await appender.append(conv, eventId, 'hello there', true);

  assert.equal(res.created, true);
  assert.equal(server.userMessages().length, 1);
  const stored = server.userMessages()[0]!;
  // Original content leads; exactly one trailing marker block; marker is body-searchable.
  assert.deepEqual(stored.content[0], { type: 'text', text: 'hello there' });
  assert.deepEqual(stored.content[1], { type: 'text', text: `<!-- ${idempotencyMarker(eventId)} -->` });
  assert.equal(stored.content.length, 2);
  assert.equal(server.search({ source: 'user', body: idempotencyMarker(eventId) }).length, 1);
  assert.equal(server.runRequests, 1);
});

test('KEY: a lost append response does NOT duplicate the user turn on retry', async () => {
  const server = new FakeUpstreamServer();
  const conv = 'conv-2';
  const appender = new IdempotentIntakeAppender(portFor(server, conv));
  const eventId = deterministicEventId('whatsapp', 'msg-B');

  // First attempt: the server persists the event, then the response is lost.
  server.loseNextResponse = true;
  await assert.rejects(() => appender.append(conv, eventId, 'ship it', true));
  assert.equal(server.userMessages().length, 1, 'event was durably persisted before the failure');

  // Retry the SAME intake row (the coordinator's claim fence guarantees this is sequential, not concurrent).
  const retry = await appender.append(conv, eventId, 'ship it', true);

  assert.equal(retry.created, false, 'marker found → idempotent no-op, no second append');
  assert.equal(server.userMessages().length, 1, 'still exactly one user turn — no duplicate');
  assert.equal(server.runRequests, 2, 'run is re-requested on the no-op path (idempotent)');
});

test('a server crash BEFORE persisting is safely re-appended (no marker found)', async () => {
  const server = new FakeUpstreamServer();
  const conv = 'conv-3';
  const eventId = deterministicEventId('whatsapp', 'msg-C');

  // Model "crashed before persist" as an append that throws WITHOUT storing anything.
  let dropFirst = true;
  const port: IdempotentAppendPort = {
    async appendUserMessage(id, content, run) {
      if (dropFirst) {
        dropFirst = false;
        throw new Error('crash before persist');
      }
      server.append(id, { role: 'user', content, run });
    },
    async hasUserMessageWithMarker(id, marker) {
      return server.search({ kind: 'MessageEvent', source: 'user', body: marker }).length > 0;
    },
    async run() {
      server.runRequests += 1;
    },
  };
  const appender = new IdempotentIntakeAppender(port);

  await assert.rejects(() => appender.append(conv, eventId, 'retry me', true));
  assert.equal(server.userMessages().length, 0, 'nothing persisted');

  const retry = await appender.append(conv, eventId, 'retry me', true);
  assert.equal(retry.created, true, 'no marker present → genuinely re-append');
  assert.equal(server.userMessages().length, 1);
});

test('identical text in two distinct messages stays two turns (why a marker beats content-matching)', async () => {
  const server = new FakeUpstreamServer();
  const conv = 'conv-4';
  const appender = new IdempotentIntakeAppender(portFor(server, conv));

  // Same body "ok", different platform message ids → different deterministic ids → different markers.
  const a = await appender.append(conv, deterministicEventId('whatsapp', 'msg-D1'), 'ok', true);
  const b = await appender.append(conv, deterministicEventId('whatsapp', 'msg-D2'), 'ok', true);

  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.equal(server.userMessages().length, 2, 'duplicate-content messages are NOT collapsed');
  assert.notEqual(a.marker, b.marker);
});

test('withMarker normalizes string and block-array content the same way', () => {
  const m = 'oh-idem:deadbeef0000';
  assert.deepEqual(withMarker('hi', m), [
    { type: 'text', text: 'hi' },
    { type: 'text', text: `<!-- ${m} -->` },
  ]);
  assert.deepEqual(withMarker([{ type: 'text', text: 'a' }], m), [
    { type: 'text', text: 'a' },
    { type: 'text', text: `<!-- ${m} -->` },
  ]);
});
