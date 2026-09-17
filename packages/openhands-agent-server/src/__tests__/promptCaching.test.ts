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
      readonly cache_control?: { readonly type: string; readonly ttl?: '5m' | '1h' };
    }[];
  }[];
}

interface ConversationInfo {
  readonly execution_status: string;
  readonly launched_agent_profile: { readonly anthropicCacheTtl: '5m' | '1h' };
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

test.each([undefined, '1h'] as const)('profile-created Anthropic proxy agents retain cache TTL (%s), context, and accounting across catalog edits and restore', async (ttl) => {
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
    const profile = { profileId: 'proxy-haiku', providerId: 'litellm_proxy', model: 'anthropic/claude-haiku-4-5', baseUrl: 'https://llm-proxy.example.test/v1', ...(ttl === undefined ? {} : { anthropicCacheTtl: ttl }) };
    expect((await server.app.inject({ method: 'POST', url: '/api/profiles/proxy-haiku', payload: profile })).statusCode).toBe(201);
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { llm_profile_ref: profile.profileId, tools: ['finish'] }, workspace: { working_dir: root } } });
    expect(started.statusCode).toBe(201);
    const id = started.json<{ id: string }>().id;
    const first = await run(server, id, 'Finish the first turn.');
    expect(first.metrics.accumulated_token_usage).toMatchObject({ prompt_tokens: 4120, cache_read_tokens: 0, cache_write_tokens: 4096 });
    expect(first.launched_agent_profile.anthropicCacheTtl).toBe(ttl ?? '5m');
    // A same-name catalog edit is for future bindings. It must not silently
    // change the existing conversation's cache policy, even after a restart.
    const changedTtl = ttl === '1h' ? '5m' : '1h';
    expect((await server.app.inject({ method: 'POST', url: '/api/profiles/proxy-haiku',
      payload: { ...profile, anthropicCacheTtl: changedTtl } })).statusCode).toBe(201);
    await server.app.close();
    server = await createAgentServerApp(options);
    expect((await readInfo(server, id)).metrics).toEqual(first.metrics);
    const second = await run(server, id, 'Finish the next turn.');
    expect(second.metrics.accumulated_token_usage).toMatchObject({ prompt_tokens: 8260, cache_read_tokens: 4096, cache_write_tokens: 4096 });
    expect(second.launched_agent_profile.anthropicCacheTtl).toBe(ttl ?? '5m');
    const newConversation = await server.app.inject({ method: 'POST', url: '/api/conversations',
      payload: { agent: { llm_profile_ref: profile.profileId, tools: ['finish'] }, workspace: { working_dir: root } } });
    expect(newConversation.statusCode).toBe(201);
    const newer = await run(server, newConversation.json<{ id: string }>().id, 'Finish a new conversation.');
    expect(newer.launched_agent_profile.anthropicCacheTtl).toBe(changedTtl);
    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      const requestTtl = index < 2 ? ttl ?? '5m' : changedTtl;
      const cacheControl = { type: 'ephemeral', ...(requestTtl === '1h' ? { ttl: '1h' } : {}) };
      const system = request.messages.find((message) => message.role === 'system');
      expect(Array.isArray(system?.content)).toBe(true);
      const content = system!.content as Exclude<typeof system.content, string>;
      expect(content.map((block) => block.text ?? '').join('\n')).toContain(memory);
      expect(content[0]?.cache_control).toEqual(cacheControl);
      const lastUser = request.messages.filter((message) => message.role === 'user').at(-1);
      expect(Array.isArray(lastUser?.content)).toBe(true);
      expect((lastUser!.content as Exclude<typeof lastUser.content, string>).at(-1)?.cache_control).toEqual(cacheControl);
    }
  } finally {
    await server.app.close();
    provider.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test('profile HTTP CRUD and OpenAPI retain the Anthropic cache TTL without provider calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-profile-cache-ttl-'));
  const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Profile CRUD must not call a provider'));
  const options = { secretStore: new InMemorySecretStore(), config: {
    conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root,
  } };
  let server = await createAgentServerApp(options);
  const profile = { profileId: 'cache-policy', providerId: 'anthropic', model: 'claude-haiku-4-5' };
  try {
    const created = await server.app.inject({ method: 'POST', url: '/api/profiles', payload: profile });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ profileId: profile.profileId, anthropicCacheTtl: '5m' });
    const updated = await server.app.inject({ method: 'POST', url: `/api/profiles/${profile.profileId}`,
      payload: { ...profile, anthropicCacheTtl: '1h' } });
    expect(updated.statusCode).toBe(201);
    expect(updated.json()).toMatchObject({ anthropicCacheTtl: '1h' });
    expect((await server.app.inject(`/api/profiles/${profile.profileId}`)).json()).toMatchObject({ anthropicCacheTtl: '1h' });
    const listed = (await server.app.inject('/api/profiles')).json<{ profiles: Array<{ profileId: string; anthropicCacheTtl: string }> }>();
    expect(listed.profiles.find((item) => item.profileId === profile.profileId)).toMatchObject({ anthropicCacheTtl: '1h' });

    for (const invalid of ['2h', '', null, 3600]) {
      expect((await server.app.inject({ method: 'POST', url: `/api/profiles/${profile.profileId}`,
        payload: { ...profile, anthropicCacheTtl: invalid } })).statusCode).toBe(422);
    }
    await server.app.close();
    server = await createAgentServerApp(options);
    expect((await server.app.inject(`/api/profiles/${profile.profileId}`)).json()).toMatchObject({ anthropicCacheTtl: '1h' });

    type BodySchema = { content: { 'application/json': { schema: { properties: Record<string, unknown> } } } };
    const openapi = (await server.app.inject('/openapi.json')).json<{ paths: Record<string, {
      post: { requestBody: BodySchema }; get: { responses: Record<string, BodySchema> };
    }> }>();
    const route = openapi.paths['/api/profiles/{name}']!;
    const ttlSchema = { type: 'string', enum: ['5m', '1h'], default: '5m' };
    expect(route.post.requestBody.content['application/json'].schema.properties.anthropicCacheTtl).toMatchObject(ttlSchema);
    expect(route.get.responses['200']!.content['application/json'].schema.properties.anthropicCacheTtl).toMatchObject(ttlSchema);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    await server.app.close();
    provider.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
