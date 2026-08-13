/**
 * Integration proof: the coordinator driving the REAL upstream-shaped agent-server, not a fake.
 *
 * This is the bridge from "unit-green" to "works against the real server". It starts an in-process
 * `@smolpaws/openhands-agent-server` (the actual Fastify app, listening on an ephemeral port), points the
 * real {@link HttpAgentServerClient} at it, and runs `resolveLane → acceptInbound → integrateNextIntake`
 * end-to-end. It asserts the append-response-loss guarantee at the real seam: the intake lands with
 * `created:true`, and an idempotent replay of the same deterministic `event_id` returns `created:false`
 * with no duplicate user turn — the `event_id` delta shipped in PR #140 (`f6b1b275b`).
 *
 * Isolated and additive: temp SQLite + temp conversations dir, no production delivery path, no worker
 * loop. Requires `@smolpaws/openhands-agent-server` (dev dependency, `file:` link to the built package).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentServerApp } from '@smolpaws/openhands-agent-server';
import Database from 'better-sqlite3';

import { MessageWorkCoordinator } from './coordinator.js';
import { HttpAgentServerClient } from './httpAgentServerClient.js';
import { deterministicConversationId, deterministicEventId } from './ids.js';
import { MessageWorkStore } from './store.js';
import type { LaneDescriptor, RetryPolicy } from './types.js';

const POLICY: RetryPolicy = { maxAttempts: 3, baseBackoffMs: 1_000, capBackoffMs: 8_000, claimTtlMs: 60_000 };
const SESSION_KEY = 'integration-slice';

/** Minimal structural view of the returned app — avoids depending on Fastify types from the host. */
interface AppLike {
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
  close(): Promise<void>;
  server: { address(): string | { readonly port: number } | null };
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

async function listen(app: AppLike): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function userMessageIds(baseUrl: string, conversationId: string): Promise<string[]> {
  const res = await fetch(
    `${baseUrl}/api/conversations/${conversationId}/events/search?kind=MessageEvent&source=user&sort_order=TIMESTAMP`,
    { headers: { 'x-session-api-key': SESSION_KEY } },
  );
  assert.equal(res.status, 200, 'events/search should return 200');
  const body = (await res.json()) as { items?: Array<{ id: string; kind: string; source: string }> };
  return (body.items ?? []).map((event) => event.id);
}

test('coordinator drives the REAL agent-server: intake lands created:true, event_id replay is created:false', async () => {
  const conversationsPath = tempDir('mwc-int-conv-');
  const dbDir = tempDir('mwc-int-db-');
  const server = await createAgentServerApp({ config: { conversationsPath, sessionApiKey: SESSION_KEY } });
  const app = server.app as unknown as AppLike;
  const baseUrl = await listen(app);
  try {
    const client = new HttpAgentServerClient({ baseUrl, sessionApiKey: SESSION_KEY });
    const store = new MessageWorkStore(new Database(path.join(dbDir, 'coordinator.db')), POLICY);
    const coord = new MessageWorkCoordinator(store, client);

    const descriptor: LaneDescriptor = {
      laneKey: 'channel:slack:T1:C1:root',
      platform: 'slack',
      accountId: 'T1',
      chatId: 'C1',
      threadId: null,
    };
    const sourceMessageId = 'm-int-1';
    const expectedConversationId = deterministicConversationId(descriptor.laneKey);
    const expectedEventId = deterministicEventId(descriptor.platform, sourceMessageId);

    // 1. resolveLane must create the conversation on the REAL server (ensureConversation → POST /api/conversations).
    const binding = await coord.resolveLane(descriptor);
    assert.equal(binding.conversationId, expectedConversationId);
    assert.equal(binding.conversationReady, true);
    const created = await fetch(`${baseUrl}/api/conversations/${expectedConversationId}`, {
      headers: { 'x-session-api-key': SESSION_KEY },
    });
    assert.equal(created.status, 200, 'the conversation should now exist on the server');

    // 2. acceptInbound (durable intake) then integrate: appends the deterministic user event with run=true.
    await coord.acceptInbound(descriptor, { sourceMessageId, content: 'hello from the integration slice' });
    const outcome = await coord.integrateNextIntake('w-int');
    assert.equal(outcome.kind, 'integrated');
    assert.equal((outcome as { eventCreated: boolean }).eventCreated, true, 'first append is created:true');

    // 3. The event landed on the real server: exactly one user MessageEvent with the deterministic id.
    const afterFirst = await userMessageIds(baseUrl, expectedConversationId);
    assert.deepEqual(afterFirst, [expectedEventId], 'one user event, under the coordinator-supplied id');

    // 4. Idempotent replay through the SAME real client + SAME deterministic id → created:false, no duplicate.
    const replay = await client.appendEvent(expectedConversationId, {
      eventId: expectedEventId,
      role: 'user',
      content: 'hello from the integration slice',
      run: true,
    });
    assert.equal(replay.created, false, 'replay of the same event_id is created:false');
    assert.equal(replay.eventId, expectedEventId);
    const afterReplay = await userMessageIds(baseUrl, expectedConversationId);
    assert.deepEqual(afterReplay, [expectedEventId], 'still exactly one user event — no duplicate turn');

    // 5. A run was requested (append carried run=true): the server processed it and the conversation is live
    //    with a defined execution status. (Full run-to-finish is covered by the agent-server's own TestLLM
    //    tests; this slice proves the coordinator↔server intake contract, not agent execution.)
    const convRes = await fetch(`${baseUrl}/api/conversations/${expectedConversationId}`, {
      headers: { 'x-session-api-key': SESSION_KEY },
    });
    const conv = (await convRes.json()) as { execution_status?: unknown };
    assert.equal(typeof conv.execution_status, 'string', 'run request left a defined execution status');
  } finally {
    await app.close();
    rmSync(conversationsPath, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});
