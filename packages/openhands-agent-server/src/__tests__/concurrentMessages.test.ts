import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent, InMemorySecretStore, ToolDefinition, llmProfileSchema, messageSchema,
  type Event, type Message,
} from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';

const roots: string[] = [];
const servers: AgentServerApp[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const reply = (text: string) => messageSchema.parse({ role: 'assistant', content: text });
const userContent = (content: unknown) => messageSchema.parse({ role: 'user', content }).content;
const withoutSystem = (messages: readonly Message[]) => messages.filter((message) => message.role !== 'system');
const lateEventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function fixture(complete: (messages: readonly Message[], number: number) => Promise<Message>, tools: ToolDefinition[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'concurrent-message-'));
  roots.push(root);
  const calls: Array<readonly Message[]> = [];
  // No provider or machine credentials: only complete() is substituted. Agent,
  // LocalConversation, REST append/run, EventLog, and restoration remain real.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request in history regression'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const options: AgentServerAppOptions = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root },
    secretStore: new InMemorySecretStore(),
    agentFactory: () => new Agent({
      llm: {
        profile: llmProfileSchema.parse({ profileId: 'fixture', providerId: 'openai', model: 'fixture' }),
        complete: async (messages) => {
          calls.push(structuredClone(messages));
          // Anthropic rejects an assistant prefill. Check the actual SDK input,
          // rather than accepting an invalid history in the deterministic client.
          if (messages.at(-1)?.role === 'assistant') {
            throw new Error('This model does not support assistant message prefill. The conversation must end with a user message.');
          }
          return { message: await complete(messages, calls.length), usage: null };
        },
      }, tools,
    }),
  };
  const server = await createAgentServerApp(options);
  servers.push(server);
  const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
  expect(created.statusCode).toBe(201);
  return { server, id: created.json<{ id: string }>().id, options, calls };
}

async function send(server: AgentServerApp, id: string, content: unknown, eventId?: string, run = true) {
  const result = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`,
    payload: { role: 'user', content, run, ...(eventId === undefined ? {} : { event_id: eventId }) } });
  expect(result.statusCode).toBe(200);
  return result.json<{ created: boolean }>();
}

async function events(server: AgentServerApp, id: string): Promise<Event[]> {
  const response = await server.app.inject(`/api/conversations/${id}/events/search?limit=100`);
  expect(response.statusCode).toBe(200);
  return response.json<{ items: Event[] }>().items;
}

async function settled(server: AgentServerApp, id: string) {
  await (await server.conversationService.getEventService(id))!.whenIdle();
  expect((await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe('finished');
  expect((await events(server, id)).filter((event) => event.kind === 'ConversationErrorEvent')).toEqual([]);
}

// Regression for smolpaws-fi0: the old projection kept the append order
// A -> B -> C -> reply(A), so the required follow-up ended in assistant prefill.
// Input may include images, and several messages can arrive before completion.
test.each([
  ['text', 'arrived during completion'],
  ['image', [
    { type: 'text', text: 'arrived during completion' },
    { type: 'image', image_urls: ['data:image/png;base64,iVBORw0KGgo='] },
  ]],
])('a late %s message is answered in request order without rewriting arrival order, including after restart', async (_kind, late) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(async (_messages, number) => {
    if (number === 1) { entered.resolve(); await release.promise; }
    return reply(`reply ${number}`);
  });
  let server = f.server;
  try {
    await send(server, f.id, 'first');
    await entered.promise;
    expect((await send(server, f.id, late, lateEventId)).created).toBe(true);
    expect((await send(server, f.id, late, lateEventId)).created).toBe(false);
    await send(server, f.id, 'another late message');
    const beforeCompletion = await events(server, f.id);
    release.resolve();
    await (await server.conversationService.getEventService(f.id))!.whenIdle();

    expect(f.calls).toHaveLength(2);
    const expected = [
      { role: 'user', content: userContent('first') },
      { role: 'assistant', content: reply('reply 1').content },
      { role: 'user', content: [...userContent(late), ...userContent('another late message')] },
    ];
    expect(withoutSystem(f.calls[1]!)).toMatchObject(expected);
    expect(f.calls[1]!.at(-1)?.role).toBe('user');
    await settled(server, f.id);

    const completed = await events(server, f.id);
    expect(completed.slice(0, beforeCompletion.length)).toEqual(beforeCompletion);
    expect(completed.filter((event) => event.kind === 'MessageEvent').map((event) => event.llm_message.content)).toEqual([
      userContent('first'), userContent(late), userContent('another late message'), reply('reply 1').content, reply('reply 2').content,
    ]);
    expect(completed.filter((event) => event.id === lateEventId)).toHaveLength(1);

    // A fresh server must recover request provenance from disk, not process state.
    await server.app.close();
    server = await createAgentServerApp(f.options);
    servers.push(server);
    expect(await events(server, f.id)).toEqual(completed);
    expect(f.calls).toHaveLength(2);
    expect((await send(server, f.id, late, lateEventId, false)).created).toBe(false);
    expect(await events(server, f.id)).toEqual(completed);
    await send(server, f.id, 'after restart');
    await settled(server, f.id);
    expect(f.calls).toHaveLength(3);
    expect(withoutSystem(f.calls[2]!)).toMatchObject([
      ...expected,
      { role: 'assistant', content: reply('reply 2').content },
      { role: 'user', content: userContent('after restart') },
    ]);
    expect((await events(server, f.id)).slice(0, completed.length)).toEqual(completed);
  } finally {
    release.resolve();
  }
});

test('input received during a tool is consumed by the next step without an extra follow-up completion', async () => {
  const entered = deferred();
  const release = deferred();
  let executions = 0;
  const tool = new ToolDefinition({
    name: 'hold', description: 'Wait at a deterministic tool boundary.',
    inputSchema: z.object({}).strict(),
    executor: async () => {
      executions += 1;
      entered.resolve();
      await release.promise;
      return { text: 'tool completed once' };
    },
  });
  const f = await fixture(async (_messages, number) => number === 1
    ? messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{
      id: 'hold-call', name: 'hold', arguments: '{}', origin: 'completion',
    }] })
    : reply('answered both inputs'), [tool]);
  try {
    await send(f.server, f.id, 'first');
    await entered.promise;
    await send(f.server, f.id, 'arrived during tool', lateEventId);
    release.resolve();
    await settled(f.server, f.id);

    expect(executions).toBe(1);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.filter((message) => message.role === 'user')).toMatchObject([
      { content: userContent('first') }, { content: userContent('arrived during tool') },
    ]);
    expect(f.calls[1]!.filter((message) => message.role === 'tool')).toMatchObject([{ tool_call_id: 'hold-call' }]);
    expect(JSON.stringify(f.calls[1])).toContain('tool completed once');
    const saved = await events(f.server, f.id);
    expect(saved.findIndex((event) => event.id === lateEventId)).toBeLessThan(saved.findIndex((event) => event.kind === 'ObservationEvent'));
    expect(saved.filter((event) => event.kind === 'ObservationEvent')).toHaveLength(1);
  } finally {
    release.resolve();
  }
});
