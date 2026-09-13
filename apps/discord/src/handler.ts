/**
 * Pure Discord intake policy: authorization, trigger detection, prompt extraction, lane identity, and
 * message chunking. No discord.js types here so it stays unit-testable.
 */
import type { LaneDescriptor } from '../../../src/coordinator/types.js';

export const DISCORD_RELAY_ID_NAMESPACE = 'discord-relay:v1';
export const DISCORD_MAX_LENGTH = 2000;

export interface DiscordAuthorizationContext {
  readonly userId: string;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly isDirectMessage: boolean;
}

export interface DiscordAuthorizationFilters {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly allowedGuilds: ReadonlySet<string>;
  readonly allowedChannels: ReadonlySet<string>;
}

export function isDiscordMessageAllowed(
  context: DiscordAuthorizationContext,
  filters: DiscordAuthorizationFilters,
): boolean {
  // Fail closed: user authorization is the security-critical gate. An empty allowlist authorizes nobody
  // (never everybody), so a missing or misnamed `DISCORD_ALLOWED_USER_IDS` denies access instead of
  // opening the bot up. Guild/channel filters keep their "empty = all scopes" semantics — they only
  // narrow *where* an already-authorized user may trigger the bot.
  if (filters.allowedUserIds.size === 0) return false;
  if (!filters.allowedUserIds.has(context.userId)) return false;
  if (context.isDirectMessage) return true;
  if (filters.allowedGuilds.size > 0 && (context.guildId === null || !filters.allowedGuilds.has(context.guildId))) return false;
  if (filters.allowedChannels.size > 0 && !filters.allowedChannels.has(context.channelId)) return false;
  return true;
}

export interface DiscordEventContext {
  readonly messageId: string;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly isDirectMessage: boolean;
  readonly isThread: boolean;
  readonly authorId: string;
  readonly authorTag: string;
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly mentionsBot: boolean;
}

export function triggerPatternFor(trigger: string): RegExp {
  return new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** DMs always count; guild messages need a mention or the text trigger. Bots never trigger the cat. */
export function shouldRespond(ctx: DiscordEventContext, triggerPattern: RegExp): boolean {
  if (ctx.authorIsBot) return false;
  if (ctx.isDirectMessage) return true;
  if (ctx.mentionsBot) return true;
  return triggerPattern.test(ctx.content);
}

export function extractPrompt(content: string, botUserId: string, triggerPattern: RegExp): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(new RegExp(triggerPattern.source, 'gi'), '')
    .trim();
}

/**
 * One durable lane per DM author, per thread, or per channel — the same granularity the legacy
 * adapter used for its conversation ids, so a channel keeps one shared conversation.
 */
export function laneDescriptorFor(ctx: DiscordEventContext, botUserId: string): LaneDescriptor {
  const chatId = ctx.isDirectMessage ? `dm:${ctx.authorId}` : ctx.isThread ? `thread:${ctx.channelId}` : `channel:${ctx.channelId}`;
  return {
    laneKey: `channel:discord:${botUserId}:${chatId}:root`,
    platform: 'discord',
    accountId: botUserId,
    // Delivery always targets the Discord channel id (DMs and threads are channels too).
    chatId: ctx.channelId,
    threadId: null,
    displayName: ctx.isDirectMessage ? `discord-dm-${ctx.authorId}` : ctx.isThread ? `discord-thread-${ctx.channelId}` : `discord-channel-${ctx.channelId}`,
  };
}

export function splitDiscordMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      const spaceSplit = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
      if (spaceSplit > splitAt) splitAt = spaceSplit;
    }
    if (splitAt < DISCORD_MAX_LENGTH * 0.3) splitAt = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

export function parseSet(envValue: string | undefined): Set<string> {
  return new Set((envValue || '').split(',').map((s) => s.trim()).filter(Boolean));
}
