import { installNetworkErrorGuard } from '../../../src/network-errors.js';
/** Standalone WhatsApp entrypoint for the Message Relay / new-agent-server path. */
import pino from 'pino';

import { buildRelayConversationDefaults } from '../../../src/shared/relayConversationDefaults.js';
import { WhatsAppBridge } from './adapter.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = pino({
  level: config.logLevel,
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

// The bridge supplies the ingress and per-chat workspace; the product server loads configured context.
const createConversationDefaults = buildRelayConversationDefaults({
  ingress: 'whatsapp',
  repoRoot: config.repoRoot,
});

const bridge = new WhatsAppBridge({ logger, serverUrl: agentServerUrl, sessionApiKey, config, createConversationDefaults });
let stopping = false;

async function main(): Promise<void> {
  installNetworkErrorGuard(logger);
  try {
    logger.info(
      {
        registeredGroupsPath: config.registeredGroupsPath,
        registeredChats: Object.keys(config.registeredGroups).length,
        contextSource: 'product-server',
      },
      'WhatsApp bridge configuration resolved',
    );
    await bridge.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start standalone WhatsApp Message Relay bridge');
    process.exitCode = 1;
  }
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down standalone WhatsApp Message Relay bridge');
  await bridge.stop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(process.exitCode ?? 0));
  });
}

void main();
