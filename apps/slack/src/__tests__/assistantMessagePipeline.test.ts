import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import pino from 'pino';

import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import { SlackCoordinatorRuntime } from '../coordinatorRuntime.js';

test(
  'SlackCoordinatorRuntime delivers a direct assistant MessageEvent from the real transpiled server',
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'slack-relay-assistant-message-'));
    const workspace = path.join(root, 'workspace');
    const dbPath = path.join(root, 'coordinator', 'slack.db');
    mkdirSync(workspace, { recursive: true });

    const sessionApiKey = 'slack-relay-assistant-message-test';
    const server = await createAgentServerApp({
      secretStore: memorySecretStore(),
      llmClientFactory: async (profile) => ({
        profile,
        complete: async () => ({
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'CAPYBARA-MESSAGE-E2E', cache_prompt: false }],
            tool_calls: null,
            tool_call_id: null,
            name: null,
            reasoning_content: null,
            thinking_blocks: [],
            responses_reasoning_item: null,
          },
          usage: null,
        }),
      }),
      config: {
        conversationsPath: path.join(root, 'conversations'),
        bashEventsPath: path.join(root, 'bash-events'),
        statePath: path.join(root, 'server-state'),
        workspaceRoot: workspace,
        allowedFileRoots: [workspace],
        sessionApiKey,
      },
    });

    let runtime: SlackCoordinatorRuntime | null = null;
    try {
      await server.app.listen({ host: '127.0.0.1', port: 0 });
      const serverUrl = localHost(server.app.server.address());
      const sent: Array<{ channel: string; text: string; threadTs?: string }> = [];

      runtime = new SlackCoordinatorRuntime({
        logger: pino({ level: 'silent' }),
        serverUrl,
        sessionApiKey,
        dbPath,
        tickMs: 60_000,
        createConversationDefaults: {
          workspace: { kind: 'LocalWorkspace', working_dir: workspace },
          tags: { ingress: 'slack' },
        },
        sendChunk: async (channel, text, threadTs) => {
          sent.push({ channel, text, threadTs });
          return '500.123';
        },
      });
      await runtime.start();
      await runtime.accept({
        conversationId: 'slack-thread-T1-C1-100.001',
        prompt: 'Return the direct assistant response.',
        messageId: '100.003',
        platformContext: {
          team_id: 'T1',
          channel_id: 'C1',
          thread_ts: '100.001',
        },
      });

      for (let attempt = 0; attempt < 20 && sent.length === 0; attempt += 1) {
        await runtime.runOnce();
        if (sent.length === 0) await delay(10);
      }

      assert.deepEqual(sent, [
        {
          channel: 'C1',
          text: 'CAPYBARA-MESSAGE-E2E',
          threadTs: '100.001',
        },
      ]);
    } finally {
      await runtime?.stop().catch(() => undefined);
      await server.app.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function memorySecretStore() {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    has: async () => false,
  };
}

function localHost(address: string | AddressInfo | null): string {
  if (address === null || typeof address === 'string') {
    throw new Error('Expected agent-server TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
