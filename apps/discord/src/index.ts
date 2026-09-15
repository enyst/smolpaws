/** Standalone Discord entrypoint for the Message Relay / new-agent-server path. */
import pino from 'pino';

import { loadKeychainSecretsByName } from '../../../src/shared/keychain.js';
import { buildRelayConversationDefaults } from '../../../src/shared/relayConversationDefaults.js';
import { DiscordBridge } from './adapter.js';

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

let bridge: DiscordBridge | undefined;
let stopping = false;

async function main(): Promise<void> {
  // The bot token lives in the macOS Keychain (service "openhands"); env still wins when set.
  try {
    const loaded = await loadKeychainSecretsByName(['DISCORD_BOT_TOKEN']);
    if (loaded.length > 0) logger.info({ loaded }, 'Loaded Discord secrets from Keychain');
  } catch (error) {
    logger.warn({ error }, 'Keychain secret load failed; relying on existing env');
  }
  const createConversationDefaults = buildRelayConversationDefaults({
    ingress: 'discord',
  });
  try {
    bridge = new DiscordBridge({ logger, serverUrl: agentServerUrl, sessionApiKey, createConversationDefaults });
    await bridge.start();
  } catch (error) {
    logger.fatal({ error }, 'Failed to start standalone Discord Message Relay bridge');
    process.exitCode = 1;
  }
}

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Shutting down standalone Discord Message Relay bridge');
  await bridge?.stop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(process.exitCode ?? 0));
  });
}

void main();
