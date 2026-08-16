/** Slack Socket Mode entrypoint for the coordinator/new-agent-server canary path. */
import pino from 'pino';
import { bridgeRegistry } from '../../../src/shared/bridgeAdapter.js';
import './adapter.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const AGENT_SERVER_URL = (
  process.env.SMOLPAWS_COORD_SERVER_URL || 'http://127.0.0.1:8790'
).replace(/\/+$/, '');
const AGENT_SERVER_API_KEY = process.env.SMOLPAWS_COORD_SERVER_API_KEY?.trim();

async function main() {
  try {
    await bridgeRegistry.startAdapter('slack', {
      runnerUrl: AGENT_SERVER_URL,
      runnerToken: AGENT_SERVER_API_KEY,
      logger,
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start Slack coordinator bridge');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down');
    void bridgeRegistry.stopAll().finally(() => process.exit(0));
  });
}

void main();
