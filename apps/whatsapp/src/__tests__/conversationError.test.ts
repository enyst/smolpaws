import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import pino from 'pino';
import { z } from 'zod';

import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import { HttpAgentServerClient } from '../../../../src/coordinator/httpAgentServerClient.js';
import { WhatsAppBridge, type ConnectionUpdate, type WhatsAppSocketLike } from '../adapter.js';
import { loadConfig } from '../config.js';

type OpenHandsAgentModule = typeof import(
  '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js'
);
type LLMClient = import('../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js').LLMClient;
const require = createRequire(import.meta.url);
const { Agent, FinishTool, TestLLM, ToolDefinition } = require(
  '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs',
) as OpenHandsAgentModule;

const SESSION_KEY = 'whatsapp-conversation-error-test';
const CHAT = '123@g.us';
const LANE_KEY = `whatsapp:4915551234:${CHAT}`;
const NOTICE = 'smolpaws: I stopped because this run reached its 1-step limit. Send another message to continue.';
const RESUMED = 'smolpaws: Continued the saved work.';
const ERROR_NOTICE = 'smolpaws: I encountered a conversation error. Send another message to try continuing.';

function assistant(id: string, name: string, args: Record<string, string> = {}) {
  return {
    role: 'assistant' as const,
    content: [],
    tool_calls: [{ id, name, arguments: JSON.stringify(args), responses_item_id: null, origin: 'completion' as const }],
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

class FakeSocket implements WhatsAppSocketLike {
  readonly handlers: Record<string, Array<(payload: never) => unknown>> = {};
  readonly sent: Array<{ jid: string; text: string }> = [];
  user = { id: '4915551234:12@s.whatsapp.net', lid: null };
  ev = {
    on: (event: string, handler: (payload: never) => unknown): void => {
      (this.handlers[event] ??= []).push(handler);
    },
  } as WhatsAppSocketLike['ev'];

  emit(event: string, payload: unknown): Promise<unknown[]> {
    return Promise.all((this.handlers[event] ?? []).map((handler) => handler(payload as never)));
  }

  async sendMessage(jid: string, content: Parameters<WhatsAppSocketLike['sendMessage']>[1], options?: { messageId: string }) {
    this.sent.push({ jid, text: content.text ?? '' });
    return { key: { id: options?.messageId ?? `WA-${this.sent.length}` } };
  }

  async sendPresenceUpdate(): Promise<void> {}

  async groupFetchAllParticipating() {
    return { [CHAT]: { subject: 'Team' } };
  }
}

async function waitFor(predicate: () => Promise<boolean>, drive: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await drive();
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the real conversation error/resume path');
}

test('real step-limit and provider errors are delivered once, and new messages resume the same conversation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsapp-conversation-error-'));
  const repoRoot = path.join(root, 'repo');
  mkdirSync(path.join(repoRoot, 'data'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'groups', 'team'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'data', 'registered_groups.json'), JSON.stringify({
    [CHAT]: { name: 'Team', folder: 'team', trigger: '@smolpaws', added_at: '2026-01-01' },
  }));
  const config = { ...loadConfig({ HOME: path.join(root, 'home') }, repoRoot), pollIntervalMs: 60_000, debounceMs: 0 };
  const relayDbPath = path.join(root, 'relay.db');
  const requests: string[] = [];
  let toolExecutions = 0;
  let agentCreations = 0;
  let throwNextCompletion = false;
  const scripted = TestLLM.fromMessages([
    assistant('inspect-1', 'inspect_saved_work'),
    assistant('finish-1', 'finish', { message: 'Continued the saved work.' }),
    assistant('inspect-2', 'inspect_saved_work'),
    assistant('finish-2', 'finish', { message: 'Continued after the provider error.' }),
  ]);
  const llm: LLMClient = {
    profile: scripted.profile,
    complete: async (messages) => {
      requests.push(JSON.stringify(messages));
      if (throwNextCompletion) {
        throwNextCompletion = false;
        throw new Error('Provider failed with test-only-secret-not-for-whatsapp');
      }
      return scripted.complete(messages);
    },
  };
  const server = await createAgentServerApp({
    agentFactory: () => {
      agentCreations += 1;
      return new Agent({
        llm,
        tools: [new ToolDefinition({
          name: 'inspect_saved_work',
          description: 'Inspect work already saved in this test conversation.',
          inputSchema: z.object({}).strict(),
          executor: () => {
            toolExecutions += 1;
            return { message: 'SAVED-WORK-CONTEXT: remembered the original task' };
          },
        }), FinishTool.create()],
      });
    },
    config: { conversationsPath: path.join(root, 'conversations'), sessionApiKey: SESSION_KEY },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new HttpAgentServerClient({ baseUrl, sessionApiKey: SESSION_KEY });
  const makeBridge = (socket: FakeSocket) => new WhatsAppBridge({
    logger: pino({ level: 'silent' }),
    serverUrl: baseUrl,
    sessionApiKey: SESSION_KEY,
    config,
    relayDbPath,
    ledgerPath: path.join(root, 'messages.db'),
    tickMs: 60_000,
    startupPing: false,
    createConversationDefaults: { max_iterations: 1 },
    socketFactory: async () => ({ socket, saveCreds: () => undefined }),
    downloadMedia: async () => Buffer.from('unused'),
  });
  let socket = new FakeSocket();
  let bridge = makeBridge(socket);
  const connect = async () => {
    await bridge.start();
    await socket.emit('connection.update', { connection: 'open' } satisfies ConnectionUpdate);
    await bridge.whenReady();
  };
  const send = async (id: string, text: string, seconds: number) => {
    await socket.emit('messages.upsert', { messages: [{
      key: { remoteJid: CHAT, id, fromMe: false, participant: '111@s.whatsapp.net' },
      message: { conversation: `@smolpaws ${text}` },
      messageTimestamp: seconds,
      pushName: 'Engel',
    }] });
    await bridge.pollOnce();
  };
  const drive = () => bridge['runtime']!.runOnce();

  try {
    await connect();
    await send('M1', 'ORIGINAL-TASK: pick up the saved work', 1_700_000_001);
    const conversationId = bridge['runtime']!.workStore.getLane(LANE_KEY)!.conversationId;
    await waitFor(async () => (await client.executionStatus(conversationId)) === 'error', drive);
    await drive();

    const firstErrors = (await client.searchEvents(conversationId, null, 100)).items
      .filter((event) => event.kind === 'ConversationErrorEvent');
    assert.equal(firstErrors.length, 1);
    assert.equal(firstErrors[0]!.code, 'MaxIterationsReached');
    assert.deepEqual(socket.sent, [{ jid: CHAT, text: NOTICE }]);
    assert.equal(toolExecutions, 1, 'an error must not automatically replay completed tool work');

    await send('M2', 'bumpity', 1_700_000_002);
    await waitFor(async () => (await client.executionStatus(conversationId)) === 'finished', drive);
    await drive();
    assert.equal(bridge['runtime']!.workStore.getLane(LANE_KEY)!.conversationId, conversationId);
    assert.deepEqual(socket.sent, [{ jid: CHAT, text: NOTICE }, { jid: CHAT, text: RESUMED }]);
    assert.equal(agentCreations, 1, 'resume must use the existing conversation');
    assert.equal(toolExecutions, 1, 'resume must not replay the completed tool');
    assert.match(requests[1]!, /ORIGINAL-TASK/);
    assert.match(requests[1]!, /SAVED-WORK-CONTEXT/);
    assert.match(requests[1]!, /bumpity/);

    // Restart the transport and deliberately reproject the EventLog from the beginning.
    await bridge.stop();
    const replayDb = new Database(relayDbPath);
    try {
      replayDb.prepare('UPDATE projection_cursors SET next_page_id = ? WHERE conversation_id = ?').run('0', conversationId);
    } finally { replayDb.close(); }
    socket = new FakeSocket();
    bridge = makeBridge(socket);
    await connect();
    await drive();
    assert.deepEqual(socket.sent, [], 'durable event IDs must suppress both the old error and normal reply');

    await send('M3', 'do another bounded task', 1_700_000_003);
    await waitFor(async () => (await client.executionStatus(conversationId)) === 'error', drive);
    await drive();
    const events = (await client.searchEvents(conversationId, null, 100)).items;
    const errors = events.filter((event) => event.kind === 'ConversationErrorEvent');
    assert.equal(errors.length, 2);
    assert.notEqual(errors[0]!.id, errors[1]!.id);
    assert.equal(errors[1]!.code, 'MaxIterationsReached');
    assert.deepEqual(socket.sent, [{ jid: CHAT, text: NOTICE }], 'a later failure with the same code needs its own notice');
    assert.equal(scripted.callCount, 3);
    assert.equal(toolExecutions, 2);

    const db = new Database(relayDbPath, { readonly: true });
    try {
      const deliveries = db.prepare('SELECT agent_event_id, state, send_attempted FROM work WHERE kind = ? ORDER BY sequence').all('delivery');
      const finish = events.find((event) => event.kind === 'ObservationEvent' && event.tool_name === 'finish');
      assert.ok(finish);
      assert.deepEqual(deliveries, [errors[0]!.id, finish.id, errors[1]!.id].map((id) => ({
        agent_event_id: id,
        state: 'done',
        send_attempted: 1,
      })));
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM lanes').get() as { count: number }).count, 1);
    } finally { db.close(); }

    // A thrown provider failure must follow the same durable, user-visible path as the SDK limit.
    throwNextCompletion = true;
    await send('M4', 'PROVIDER-TASK: try the next task', 1_700_000_004);
    await waitFor(async () => (await client.executionStatus(conversationId)) === 'error', drive);
    await drive();
    assert.deepEqual(socket.sent, [{ jid: CHAT, text: NOTICE }, { jid: CHAT, text: ERROR_NOTICE }]);
    assert.doesNotMatch(JSON.stringify(socket.sent), /test-only-secret/);
    const allErrors = (await client.searchEvents(conversationId, null, 100)).items
      .filter((event) => event.kind === 'ConversationErrorEvent');
    assert.equal(allErrors.length, 3, 'the thrown provider error must be durable');
    assert.equal(scripted.callCount, 3);
    assert.equal(toolExecutions, 2);

    await send('M5', 'continue after the provider error', 1_700_000_005);
    await waitFor(async () => (await client.executionStatus(conversationId)) === 'finished', drive);
    await drive();
    assert.equal(bridge['runtime']!.workStore.getLane(LANE_KEY)!.conversationId, conversationId);
    assert.deepEqual(socket.sent, [
      { jid: CHAT, text: NOTICE },
      { jid: CHAT, text: ERROR_NOTICE },
      { jid: CHAT, text: 'smolpaws: Continued after the provider error.' },
    ]);
    assert.equal(agentCreations, 1);
    assert.equal(toolExecutions, 2, 'provider recovery must not replay completed tools');
    assert.equal(scripted.callCount, 4);
    assert.match(requests[4]!, /ORIGINAL-TASK/);
    assert.match(requests[4]!, /SAVED-WORK-CONTEXT/);
    assert.match(requests[4]!, /PROVIDER-TASK/);
    assert.match(requests[4]!, /continue after the provider error/);
    await drive();
    assert.equal(socket.sent.length, 3, 'settled generic error notices must not be sent again');
  } finally {
    await bridge.stop();
    await server.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
