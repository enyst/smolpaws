import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, FinishTool, InMemorySecretStore, TestLLM, conversationErrorEventSchema, messageSchema, type Event } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { pathContainsPlaintext } from '../../examples/plaintextScan.js';
import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';

// Adapted from pinned tests/agent_server/test_event_service.py:
// test_run_exception_emits_conversation_error_event / test_run_conversation_run_error_does_not_double_emit.
const roots: string[] = [];
const servers: AgentServerApp[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function finish(id: string) {
  return messageSchema.parse({ role: 'assistant', content: [], tool_calls: [
    { id, name: 'finish', arguments: JSON.stringify({ message: 'resumed' }), origin: 'completion' },
  ] });
}

async function fixture(agentFactory: AgentServerAppOptions['agentFactory']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-conversation-error-'));
  roots.push(root);
  const options = { agentFactory, secretStore: new InMemorySecretStore(), config: {
    conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
    bashEventsPath: path.join(root, 'bash'), workspaceRoot: root,
  } };
  const server = await createAgentServerApp(options);
  servers.push(server);
  const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
  expect(created.statusCode).toBe(201);
  return { server, id: created.json<{ id: string }>().id, options, root };
}

async function run(server: AgentServerApp, id: string, status: 'error' | 'finished'): Promise<void> {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`,
    payload: { role: 'user', content: 'Continue the saved work.', run: true } });
  expect(response.statusCode).toBe(200);
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe(status);
}

async function errors(server: AgentServerApp, id: string) {
  const response = await server.app.inject(`/api/conversations/${id}/events/search?kind=ConversationErrorEvent`);
  expect(response.statusCode).toBe(200);
  return response.json<{ items: Event[] }>().items;
}

describe('durable conversation run failures', () => {
  test('publishes a provider failure over HTTP and WebSocket, preserves it on restart, and permits a fresh retry', async () => {
    const secret = 'fixture-provider-secret-must-not-persist';
    const requestSecret = 'fixture-request-secret-must-not-serialize';
    const bearerSecret = 'fixture-bearer-secret-must-not-persist';
    const failure = Object.assign(new Error(`bad gateway api_key=${secret}; Authorization: Bearer ${bearerSecret}`), {
      request: { headers: { authorization: `Bearer ${requestSecret}` } },
      cause: new Error(requestSecret),
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const llm = TestLLM.fromMessages([failure, finish('finish-after-retry'), failure]);
    const { server, id, options, root } = await fixture(() => new Agent({ llm, tools: [FinishTool.create()] }));
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP server');
    const emitted: Event[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/sockets/events/${id}`);
    sockets.push(socket);
    socket.addEventListener('message', (message) => { emitted.push(JSON.parse(String(message.data)) as Event); });
    await expect.poll(() => emitted.some((event) => event.kind === 'ConversationStateUpdateEvent')).toBe(true);

    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    const first = (await errors(server, id))[0]!;
    expect(first).toMatchObject({ kind: 'ConversationErrorEvent', source: 'environment', code: 'Error',
      detail: 'bad gateway api_key=<redacted> Authorization: Bearer <redacted>', classification: { kind: 'transient', retryable: true } });
    await expect.poll(() => emitted.filter((event) => event.kind === 'ConversationErrorEvent')).toEqual([first]);
    await expect.poll(() => emitted.at(-1)).toMatchObject({ kind: 'ConversationStateUpdateEvent', value: { execution_status: 'error' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(requestSecret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(bearerSecret);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
    expect(await pathContainsPlaintext(root, requestSecret)).toBe(false);
    expect(await pathContainsPlaintext(root, bearerSecret)).toBe(false);

    socket.close();
    await server.app.close();
    servers.splice(servers.indexOf(server), 1);
    const restored = await createAgentServerApp(options);
    servers.push(restored);
    expect(await errors(restored, id)).toEqual([first]);
    await run(restored, id, 'finished');
    expect(await errors(restored, id)).toEqual([first]);
    await run(restored, id, 'error');
    await expect.poll(async () => (await errors(restored, id)).length).toBe(2);
    const repeated = await errors(restored, id);
    expect(repeated[1]).toMatchObject({ code: 'Error', detail: 'bad gateway api_key=<redacted> Authorization: Bearer <redacted>' });
    expect(repeated[1]!.id).not.toBe(first.id);
    expect(llm.callCount).toBe(3);
  });

  test('makes a factory failure durable before an agent exists and retries factory construction on the next prompt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const factory = vi.fn(() => {
      if (factory.mock.calls.length === 1) throw new TypeError('duplicate tool names');
      return new Agent({ llm: TestLLM.fromMessages([finish('factory-retry')]), tools: [FinishTool.create()] });
    });
    const { server, id } = await fixture(factory);
    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    expect((await errors(server, id))[0]).toMatchObject({ code: 'TypeError', detail: 'duplicate tool names',
      classification: { kind: 'internal', retryable: false } });
    await run(server, id, 'finished');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(await errors(server, id)).toHaveLength(1);
  });

  test('publishes an error already appended by the agent without emitting a second backstop event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const existing = conversationErrorEventSchema.parse({ source: 'environment', code: 'LLMTimeoutError', detail: 'timeout' });
    const { server, id } = await fixture(() => {
      const agent = new Agent({ llm: TestLLM.fromMessages([]), tools: [FinishTool.create()] });
      agent.step = async (state) => {
        await state.appendEventAsync(existing);
        throw new Error('already surfaced');
      };
      return agent;
    });
    const emitted: Event[] = [];
    const service = (await server.conversationService.getEventService(id))!;
    await service.subscribeToEvents((event) => { emitted.push(event); });
    await run(server, id, 'error');
    expect(await errors(server, id)).toEqual([existing]);
    await expect.poll(() => emitted.filter((event) => event.kind === 'ConversationErrorEvent')).toEqual([existing]);
  });

  test('does not serialize arbitrary thrown objects into the event or logs', async () => {
    const secret = 'fixture-arbitrary-thrown-object-secret';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, id, root } = await fixture(() => { throw { token: secret, toString: () => secret }; });
    await run(server, id, 'error');
    await expect.poll(async () => (await errors(server, id)).length).toBe(1);
    expect((await errors(server, id))[0]).toMatchObject({ code: 'Error', detail: 'Conversation run failed.' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(await pathContainsPlaintext(root, secret)).toBe(false);
  });
});
