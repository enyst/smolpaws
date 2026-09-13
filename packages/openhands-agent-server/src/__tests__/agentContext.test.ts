import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, TestLLM, type LLMClient, type Message } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, test } from 'vitest';

import { createAgentServerApp } from '../app.js';
import { agentContextFromRequestAgent } from '../profileAgentFactory.js';

const SUFFIX = 'You are paws, the SmolPaws cat. CONTEXT-MARKER-7f3a';

function llmProfilePayload(profileId: string, model: string): Record<string, unknown> {
  return {
    profileId,
    providerId: 'openai',
    model,
    baseUrl: null,
    openAiApiMode: 'responses',
    temperature: null,
    topP: null,
    topK: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    timeoutSeconds: 120,
    reasoningEffort: null,
    reasoningSummary: null,
    headers: {},
    useProfileKeyOverride: true,
  };
}

async function waitFor(check: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

describe('agentContextFromRequestAgent', () => {
  test('returns null when the request agent carries no context', () => {
    expect(agentContextFromRequestAgent(undefined)).toBeNull();
    expect(agentContextFromRequestAgent({ llm_profile_ref: 'x' })).toBeNull();
    expect(agentContextFromRequestAgent({ agent_context: null })).toBeNull();
  });

  test('parses the supported context fields strictly', () => {
    expect(agentContextFromRequestAgent({ agent_context: { system_message_suffix: 'hi' } })).toEqual({
      system_message_suffix: 'hi',
      user_message_suffix: null,
    });
    expect(() => agentContextFromRequestAgent({ agent_context: { skills: [] } })).toThrow();
  });
});

describe('conversation agent_context', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('a partial request agent overlays server settings and its context reaches the system prompt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-context-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const seenSystemPrompts: string[] = [];

    const { app } = await createAgentServerApp({
      config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root },
      secretStore: new InMemorySecretStore(),
      llmClientFactory: async (profile) => {
        const inner = TestLLM.fromMessages([{
          role: 'assistant',
          content: [],
          tool_calls: [{ id: 'finish-context', name: 'finish', arguments: JSON.stringify({ message: 'done' }), origin: 'completion' }],
        }]);
        const recording: LLMClient = {
          profile,
          async complete(messages: readonly Message[], tools) {
            const system = messages.find((message) => message.role === 'system');
            const content = system?.content;
            seenSystemPrompts.push(
              typeof content === 'string'
                ? content
                : JSON.stringify(content ?? ''),
            );
            return inner.complete(messages, tools);
          },
        };
        return recording;
      },
    });

    try {
      const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: llmProfilePayload('gpt-nano', 'gpt-5-nano') });
      expect(created.statusCode, created.body).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/profiles/gpt-nano/activate' })).statusCode).toBe(200);
      const base = (await app.inject({ method: 'GET', url: '/api/settings' })).json<{ agent_settings: Record<string, unknown>; conversation_settings: Record<string, unknown> }>();
      expect((await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: {
          agent_settings: { ...base.agent_settings, llm_profile_ref: 'gpt-nano', tools: ['finish'] },
          conversation_settings: base.conversation_settings,
          llm_api_key: 'test-openai-key',
        },
      })).statusCode).toBe(200);

      const started = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: {
          workspace: { working_dir: workspace },
          agent: { agent_context: { system_message_suffix: SUFFIX } },
        },
      });
      expect(started.statusCode).toBe(201);
      const info = started.json<{ id: string; agent: { llm_profile_ref: string; tools: unknown[]; agent_context: { system_message_suffix: string } } }>();
      // Overlay semantics: server defaults survive, the caller's context is attached.
      expect(info.agent.llm_profile_ref).toBe('gpt-nano');
      expect(info.agent.tools).toEqual(['finish']);
      expect(info.agent.agent_context.system_message_suffix).toBe(SUFFIX);

      expect((await app.inject({
        method: 'POST',
        url: `/api/conversations/${info.id}/events`,
        payload: { role: 'user', content: 'hello', run: true },
      })).statusCode).toBe(200);
      await waitFor(async () => {
        const final = await app.inject({ method: 'GET', url: `/api/conversations/${info.id}/agent_final_response` });
        expect(final.json<{ response: string }>().response).toBe('done');
      });

      expect(seenSystemPrompts.length).toBeGreaterThan(0);
      expect(seenSystemPrompts[0]).toContain(SUFFIX);
    } finally {
      await app.close();
    }
  });
});
