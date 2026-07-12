import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  FinishTool,
  MacOSKeychainSecretStore,
  RemoteConversation,
  createClientFromProfile,
  llmProfileSecretRef,
  type LLMProfile,
} from '@smolpaws/openhands-agent';

import { createAgentServerApp } from '../src/app.js';

const apiKey = process.env.OPENAI_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error('Set OPENAI_API_KEY to run this manual smoke. It is stored in macOS Keychain for the process-local profile, not in package files.');
}

const profile: LLMProfile = {
  profileId: 'manual-smoke-openai',
  providerId: 'openai',
  model: process.env.OPENAI_MODEL ?? 'gpt-5-nano',
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

const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-manual-'));
const secretStore = new MacOSKeychainSecretStore();
await secretStore.set(llmProfileSecretRef(profile.profileId), apiKey);

const llm = await createClientFromProfile(profile, secretStore);
const agentFactory = () => new Agent({ llm, tools: [FinishTool.create()] });
const server = await createAgentServerApp({ agentFactory, config: { conversationsPath: path.join(root, 'conversations'), workspaceRoot: root, sessionApiKey: 'manual-smoke' }, secretStore });

try {
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const host = `http://127.0.0.1:${address.port}`;
  const start = await fetch(`${host}/api/conversations`, { method: 'POST', headers: { 'x-session-api-key': 'manual-smoke', 'content-type': 'application/json' }, body: '{}' });
  if (!start.ok) throw new Error(`Failed to start conversation: ${start.status} ${await start.text()}`);
  const { id } = await start.json() as { id: string };
  const conversation = new RemoteConversation({ host, conversationId: id, apiKey: 'manual-smoke' });
  await conversation.sendMessage('Reply by calling the finish tool with the exact message "manual-smoke-ok".');
  await conversation.run({ pollIntervalMs: 500, timeoutMs: 120_000 });
  const final = await fetch(`${host}/api/conversations/${id}/agent_final_response`, { headers: { 'x-session-api-key': 'manual-smoke' } });
  if (!final.ok) throw new Error(`Failed to fetch final response: ${final.status} ${await final.text()}`);
  console.log(await final.text());
} finally {
  await server.app.close();
  await rm(root, { recursive: true, force: true });
}
