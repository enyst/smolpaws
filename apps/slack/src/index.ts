/** Standalone Slack Socket Mode entrypoint for the Message Relay/new-agent-server path. */
import pino from 'pino';

import {
  buildRelayConversationDefaults,
  privateMemoryFiles,
} from '../../../src/shared/relayConversationDefaults.js';
import { SlackBridge } from './adapter.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const agentServerUrl = (
  process.env.SMOLPAWS_RELAY_SERVER_URL ||
  process.env.SMOLPAWS_COORD_SERVER_URL ||
  'http://127.0.0.1:8790'
).replace(/\/+$/, '');
const sessionApiKey =
  process.env.SMOLPAWS_RELAY_SERVER_API_KEY?.trim() ||
  process.env.SMOLPAWS_COORD_SERVER_API_KEY?.trim();
// New lanes get a real working directory (the cat's home checkout) and the SmolPaws identity docs as
// conversation context; without these the agent-server defaults to a cwd-relative workspace that does not
// exist and the model has no idea it is paws.
const createConversationDefaults = buildRelayConversationDefaults({
  ingress: 'slack',
  extraContextFiles: privateMemoryFiles(),
});
const bridge = new SlackBridge({ logger, serverUrl: agentServerUrl, sessionApiKey, createConversationDefaults });
let stopping = false;

async function main(): Promise<void> {
  try {
    logger.info(
      { workingDir: (createConversationDefaults.workspace as { working_dir: string }).working_dir, hasContext: createConversationDefaults.agent !== undefined },
      'Relay conversation defaults resolved',
    );
    await bridge.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start standalone Slack Message Relay bridge');
    process.exitCode = 1;
  }
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down standalone Slack Message Relay bridge');
  await bridge.stop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(process.exitCode ?? 0));
  });
}

void main();
