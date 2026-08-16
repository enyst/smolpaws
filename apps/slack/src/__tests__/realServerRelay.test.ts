import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import pino from 'pino';

import { createAgentServerApp } from '../../../../packages/openhands-agent-server/src/app.js';
import {
  Agent,
  FinishTool,
  TestLLM,
} from '../../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.mjs';
import { SlackCoordinatorRuntime } from '../coordinatorRuntime.js';

const SESSION_KEY = 'slack-real-server-relay';
const EXPECTED_REPLY = 'CAPYBARA-REAL-SERVER-RELAY';

interface AppLike {
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
  close(): Promise<void>;
  server: { address(): string | { readonly port: number } | null };
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function agentFactory() {
  return new Agent({
    llm: TestLLM.fromMessages([
      {
        role: 'assistant',
        content: [],
        tool_calls: [
          {
            id: 'finish-call-slack-relay',
            name: 'finish',
            arguments: JSON.stringify({ message: EXPECTED_REPLY }),
            origin: 'completion',
          },
        ],
      },
    ]),
    tools: [FinishTool.create()],
  });
}

async function listen(app: AppLike): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  drive: () => Promise<void>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await drive();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the real Slack relay path');
}

test('Slack ingress reaches the real TypeScript agent-server and returns through the durable relay', async () => {
  const conversationsPath = tempDir('slack-relay-conversations-');
  const coordinatorDir = tempDir('slack-relay-coordinator-');
  const dbPath = path.join(coordinatorDir, 'slack.db');

  const server = await createAgentServerApp({
    agentFactory,
    config: { conversationsPath, sessionApiKey: SESSION_KEY },
  });
  const app = server.app as unknown as AppLike;
  const baseUrl = await listen(app);

  const sent: Array<{
    channel: string;
    text: string;
    threadTs?: string;
  }> = [];
  const runtime = new SlackCoordinatorRuntime({
    logger: pino({ level: 'silent' }),
    serverUrl: baseUrl,
    sessionApiKey: SESSION_KEY,
    dbPath,
    tickMs: 60_000,
    sendChunk: async (channel, text, threadTs) => {
      sent.push({ channel, text, threadTs });
      return '1700000000.123456';
    },
  });

  try {
    await runtime.start();
    await runtime.accept({
      conversationId: 'slack-thread-T1-C1-100.001',
      prompt: 'Return the deterministic test response.',
      messageId: 'C1:100.002',
      platformContext: {
        team_id: 'T1',
        channel_id: 'C1',
        thread_ts: '100.001',
      },
    });

    await waitFor(
      () => sent.length > 0,
      () => runtime.runOnce(),
    );

    assert.deepEqual(sent, [
      {
        channel: 'C1',
        text: EXPECTED_REPLY,
        threadTs: '100.001',
      },
    ]);
  } finally {
    await runtime.stop();
    await app.close();
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT kind, state, send_attempted, external_message_id
         FROM work
         ORDER BY kind ASC, sequence ASC`,
      )
      .all() as Array<{
      kind: string;
      state: string;
      send_attempted: number;
      external_message_id: string | null;
    }>;

    assert.deepEqual(rows, [
      {
        kind: 'delivery',
        state: 'done',
        send_attempted: 1,
        external_message_id: '1700000000.123456',
      },
      {
        kind: 'intake',
        state: 'done',
        send_attempted: 0,
        external_message_id: null,
      },
    ]);
  } finally {
    db.close();
    rmSync(conversationsPath, { recursive: true, force: true });
    rmSync(coordinatorDir, { recursive: true, force: true });
  }
});
