import { parseSet, triggerPatternFor } from './handler.js';

export interface DiscordConfig {
  botToken: string;
  triggerPattern: RegExp;
  allowedUserIds: Set<string>;
  allowedGuilds: Set<string>;
  allowedChannels: Set<string>;
  /** Announce readiness in explicitly configured channels; default true. */
  startupPing?: boolean;
  /** Explicit startup destinations; falls back to allowedChannels when absent. */
  startupChannelIds?: Set<string>;
  logLevel: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = () => undefined,
): DiscordConfig {
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN is required');

  // Reject an ambiguous config that sets both the removed variable and its replacement.
  if (env.DISCORD_ALLOWED_USERS && env.DISCORD_ALLOWED_USER_IDS) {
    throw new Error('DISCORD_ALLOWED_USERS was removed; set only DISCORD_ALLOWED_USER_IDS (immutable account IDs).');
  }
  if (env.DISCORD_ALLOWED_USERS) {
    warn('DISCORD_ALLOWED_USERS is removed and ignored; migrate to DISCORD_ALLOWED_USER_IDS (immutable account IDs).');
  }
  const allowedUserIds = parseSet(env.DISCORD_ALLOWED_USER_IDS);
  if (allowedUserIds.size === 0) {
    warn('DISCORD_ALLOWED_USER_IDS is empty; no users are authorized to trigger the bot (fail closed).');
  }

  return {
    botToken,
    triggerPattern: triggerPatternFor(env.DISCORD_TRIGGER || '@smolpaws'),
    allowedUserIds,
    allowedGuilds: parseSet(env.DISCORD_ALLOWED_GUILDS),
    allowedChannels: parseSet(env.DISCORD_ALLOWED_CHANNELS),
    startupPing: env.SMOLPAWS_DISCORD_STARTUP_PING !== '0',
    startupChannelIds: parseSet(env.SMOLPAWS_DISCORD_STARTUP_CHANNEL_IDS ?? env.DISCORD_ALLOWED_CHANNELS),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
