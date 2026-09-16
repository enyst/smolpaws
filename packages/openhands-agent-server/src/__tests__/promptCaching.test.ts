import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentContext, InMemorySecretStore, Skill, llmProviderSecretRef } from '@smolpaws/openhands-agent';
import { expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp } from '../app.js';

interface ChatRequest {
  readonly messages: readonly {
    readonly role: string;
    readonly content: string | readonly {
      readonly type: string;
      readonly text?: string;
      readonly cache_control?: { readonly type: string };
    }[];
  }[];
}

interface ConversationInfo {
  readonly execution_status: string;
  readonly metrics: { readonly accumulated_token_usage: {
    readonly prompt_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_write_tokens: number;
  } };
}

async function readInfo(server: AgentServerApp, id: string): Promise<ConversationInfo> {
  const response = await server.app.inject(`/api/conversations/${id}`);
  expect(response.statusCode).toBe(200);
  return response.json<ConversationInfo>();
}

async function run(server: AgentServerApp, id: string, content: string): Promise<ConversationInfo> {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content, run: true } });
  expect(response.statusCode).toBe(200);
  await expect.poll(async () => (await readInfo(server, id)).execution_status).toBe('finished');
  return readInfo(server, id);
}

test('profile-created Anthropic proxy agents cache configured context and retain provider cache accounting on restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-server-prompt-cache-'));
  const memory = `# MEMORY.md\n${'Stable configured project context.\n'.repeat(600)}`;
  const requests: ChatRequest[] = [];
  const secretStore = new InMemorySecretStore();
  await secretStore.set(llmProviderSecretRef('litellm_proxy'), 'fixture-key');
  // Mock only the provider boundary: profile routing, SDK Agent request assembly,
  // configured context, serialization, accounting and persistence are real.
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://llm-proxy.example.test/v1/chat/completions');
    requests.push(JSON.parse(String(init?.body)) as ChatRequest);
    const call = requests.length;
    return new Response(JSON.stringify({
      id: `cached-completion-${call}`,
      model: 'anthropic/claude-haiku-4-5',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `finish-${call}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ message: 'done' }) } }] } }],
      usage: { prompt_tokens: 4100 + call * 20, completion_tokens: 10, total_tokens: 4110 + call * 20, prompt_tokens_details: { cached_tokens: call === 1 ? 0 : 4096, cache_write_tokens: call === 1 ? 4096 : 0 } },
    }), { headers: { 'content-type': 'application/json' } });
  });
  const options = {
    secretStore,
    configureContext: () => new AgentContext({ skills: [new Skill({ name: 'project-memory', content: memory, trigger: null })] }),
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root },
  };
  let server = await createAgentServerApp(options);
  try {
    const profile = { profileId: 'proxy-haiku', providerId: 'litellm_proxy', model: 'anthropic/claude-haiku-4-5', baseUrl: 'https://llm-proxy.example.test/v1' };
    expect((await server.app.inject({ method: 'POST', url: '/api/profiles/proxy-haiku', payload: profile })).statusCode).toBe(201);
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { llm_profile_ref: profile.profileId, tools: ['finish'] }, workspace: { working_dir: root } } });
    expect(started.statusCode).toBe(201);
    const id = started.json<{ id: string }>().id;
    const first = await run(server, id, 'Finish the first turn.');
    expect(first.metrics.accumulated_token_usage).toMatchObject({ prompt_tokens: 4120, cache_read_tokens: 0, cache_write_tokens: 4096 });
    await server.app.close();
    server = await createAgentServerApp(options);
    expect((await readInfo(server, id)).metrics).toEqual(first.metrics);
    const second = await run(server, id, 'Finish the next turn.');
    expect(second.metrics.accumulated_token_usage).toMatchObject({ prompt_tokens: 8260, cache_read_tokens: 4096, cache_write_tokens: 4096 });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const system = request.messages.find((message) => message.role === 'system');
      expect(Array.isArray(system?.content)).toBe(true);
      const content = system!.content as Exclude<typeof system.content, string>;
      expect(content.map((block) => block.text ?? '').join('\n')).toContain(memory);
      expect(content[0]?.cache_control).toEqual({ type: 'ephemeral' });
      const lastUser = request.messages.filter((message) => message.role === 'user').at(-1);
      expect(Array.isArray(lastUser?.content)).toBe(true);
      expect((lastUser!.content as Exclude<typeof lastUser.content, string>).at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    }
  } finally {
    await server.app.close();
    provider.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
