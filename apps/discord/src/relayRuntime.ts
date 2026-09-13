import type { Logger } from 'pino';

import { RelayRuntime, defaultRelayDbPath } from '../../../src/coordinator/relayRuntime.js';
import type { MessageWorkStore } from '../../../src/coordinator/store.js';
import type { LaneDescriptor } from '../../../src/coordinator/types.js';
import { DiscordDeliveryTarget, type DiscordChunkSender } from './deliveryTarget.js';
import { DISCORD_RELAY_ID_NAMESPACE } from './handler.js';

export interface DiscordRelayRuntimeOptions {
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  sendChunk: DiscordChunkSender;
  dbPath?: string;
  tickMs?: number;
  createConversationDefaults?: Record<string, unknown>;
}

/** Discord over the shared Message Relay: own store, own `discord-relay:v1` conversation namespace. */
export class DiscordRelayRuntime {
  private readonly runtime: RelayRuntime;

  constructor(options: DiscordRelayRuntimeOptions) {
    this.runtime = new RelayRuntime({
      platform: 'discord',
      idNamespace: DISCORD_RELAY_ID_NAMESPACE,
      logger: options.logger,
      serverUrl: options.serverUrl,
      sessionApiKey: options.sessionApiKey,
      target: new DiscordDeliveryTarget(options.sendChunk),
      dbPath: options.dbPath ?? defaultRelayDbPath('discord'),
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      ...(options.createConversationDefaults === undefined
        ? {}
        : { createConversationDefaults: options.createConversationDefaults }),
    });
  }

  get workStore(): MessageWorkStore {
    return this.runtime.workStore;
  }

  start(): Promise<void> {
    return this.runtime.start();
  }

  stop(): Promise<void> {
    return this.runtime.stop();
  }

  accept(lane: LaneDescriptor, sourceMessageId: string, content: string): Promise<void> {
    return this.runtime.accept({ lane, message: { sourceMessageId, content } });
  }

  runOnce(): Promise<void> {
    return this.runtime.runOnce();
  }
}
