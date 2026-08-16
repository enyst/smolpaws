/**
 * Slack canary bridge for the new durable message-work architecture.
 *
 * Slack is intentionally greenfield here: it does NOT use the legacy `/turns` dispatch path. Socket
 * Mode ingress is normalized by slackHandler, accepted by SlackCoordinatorRuntime, integrated into the
 * upstream-shaped TypeScript agent-server, synced into the durable delivery outbox, then sent back to
 * Slack by DeliveryDispatcher through SlackDeliveryTarget.
 */
import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import {
  BaseBridgeAdapter,
  bridgeRegistry,
  type BridgeAdapterConfig,
  type IncomingMessage,
  type ReplyContext,
} from '../../../src/shared/bridgeAdapter.js';
import { loadConfig, type SlackConfig } from './config.js';
import { SlackCoordinatorRuntime } from './coordinatorRuntime.js';
import {
  GuestRateLimiter,
  MentionedThreadTracker,
  MessageDeduplicator,
  isThreadContextMessageSubtype,
  replyThreadTs,
  type SlackEventContext,
  type ThreadMessage,
} from './slackContext.js';
import { handleSlackEvent, splitMessage, type SlackDeps } from './slackHandler.js';

export type SlackAdapterConfig = BridgeAdapterConfig & {
  slackConfig: SlackConfig;
};

export class SlackAdapter extends BaseBridgeAdapter {
  private app?: App;
  private runtime?: SlackCoordinatorRuntime;
  private botUserId = '';
  private readonly slackConfig: SlackConfig;
  private readonly dedup = new MessageDeduplicator();
  private readonly guestLimiter = new GuestRateLimiter();
  private readonly mentionedThreads = new MentionedThreadTracker();

  constructor(config: SlackAdapterConfig) {
    super(config);
    this.slackConfig = config.slackConfig;
  }

  protected async connect(): Promise<void> {
    const app = new App({
      token: this.slackConfig.botToken,
      appToken: this.slackConfig.appToken,
      socketMode: true,
    });
    this.app = app;

    const deps = this.buildDeps();

    app.event('app_mention', async ({ event, context }) => {
      await this.processEvent(event, context.teamId, false, deps);
    });

    app.event('message', async ({ event, context }) => {
      const msg = event as GenericMessageEvent;
      if (msg.subtype) return;

      const isDm = msg.channel_type === 'im';
      if (!isDm) {
        if (!msg.thread_ts || !this.mentionedThreads.isTracked(msg.thread_ts)) return;
      }

      await this.processEvent(msg, context.teamId, isDm, deps);
    });

    const auth = await app.client.auth.test();
    if (!auth.user_id) {
      throw new Error('Slack auth.test succeeded but returned no user_id');
    }
    this.botUserId = auth.user_id;

    this.runtime = new SlackCoordinatorRuntime({
      logger: this.logger,
      serverUrl: this.runnerUrl,
      sessionApiKey: this.runnerToken,
      sendChunk: async (channel, text, threadTs) => {
        const result = await app.client.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
          unfurl_links: false,
          unfurl_media: false,
        });
        return result.ts ?? null;
      },
    });
    await this.runtime.start();
    await app.start();

    this.logger.info(
      { botUserId: this.botUserId, team: auth.team, agentServer: this.runnerUrl },
      'SmolPaws Slack bot is ready on coordinator path 🐾',
    );
  }

  protected async disconnect(): Promise<void> {
    // Stop ingress first, then let any currently running coordinator tick settle before closing SQLite.
    try {
      await this.app?.stop();
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to stop Slack Socket Mode app cleanly');
    }
    try {
      await this.runtime?.stop();
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to stop Slack coordinator runtime cleanly');
    } finally {
      this.runtime = undefined;
      this.app = undefined;
    }
  }

  /**
   * Slack deliberately overrides the shared legacy bridge dispatch. Its success boundary is durable
   * coordinator acceptance; the background relay owns the eventual reply.
   */
  protected override async dispatch(
    message: IncomingMessage,
    _replyContext: ReplyContext,
  ): Promise<void> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      throw new Error('Slack coordinator runtime is not started');
    }
    await runtime.accept(message);
  }

  // Required by BaseBridgeAdapter but not used by Slack's authoritative coordinator path. Keeping this
  // implementation makes the inherited lifecycle/registry contract harmless for existing bridge loader
  // callers without coupling Slack delivery back to that old dispatch mechanism.
  protected async sendReply(ctx: ReplyContext, text: string): Promise<void> {
    const event = ctx.original as SlackEventContext | undefined;
    if (!event?.channelId || !event.ts) {
      this.logger.error(
        { conversationId: ctx.conversationId },
        'Cannot send Slack reply: missing event context',
      );
      return;
    }
    await this.postMessage(event.channelId, text, replyThreadTs(event));
  }

  private async processEvent(
    event: SlackEventLike,
    teamId: string | undefined,
    isDm: boolean,
    deps: SlackDeps,
  ): Promise<void> {
    if (!this.botUserId || !event.user) return;
    if (event.bot_id || event.user === this.botUserId) return;

    if (!teamId) {
      this.logger.warn(
        { channel: event.channel, ts: event.ts, user: event.user },
        'Slack event missing team context',
      );
      return;
    }

    const ctx: SlackEventContext = {
      teamId,
      channelId: event.channel,
      userId: event.user,
      ts: event.ts,
      threadTs: event.thread_ts,
      text: event.text ?? '',
      isDm,
      botUserId: this.botUserId,
    };

    try {
      await handleSlackEvent(ctx, deps);
    } catch (error) {
      this.logger.error(
        { err: error, channel: event.channel, ts: event.ts, user: event.user },
        'Failed to handle Slack event',
      );
    }
  }

  private buildDeps(): SlackDeps {
    return {
      config: this.slackConfig,
      dedup: this.dedup,
      guestLimiter: this.guestLimiter,
      mentionedThreads: this.mentionedThreads,
      logger: this.logger,
      postMessage: (channel, text, threadTs) => this.postMessage(channel, text, threadTs),
      addReaction: (channel, timestamp, name) => this.addReaction(channel, timestamp, name),
      fetchThreadMessages: (channel, threadTs) => this.fetchThreadMessages(channel, threadTs),
      dispatch: (message, replyContext) => this.dispatch(message, replyContext),
    };
  }

  private async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    const app = this.app;
    if (!app) return;
    for (const chunk of splitMessage(text)) {
      await app.client.chat.postMessage({
        channel,
        text: chunk,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
    }
  }

  private async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    const app = this.app;
    if (!app) return;
    await app.client.reactions.add({ channel, timestamp, name });
  }

  private async fetchThreadMessages(channel: string, threadTs: string): Promise<ThreadMessage[]> {
    const app = this.app;
    if (!app) return [];
    const result = await app.client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    if (!result.messages) return [];
    const messages = result.messages as ReadonlyArray<SlackThreadReply>;
    const threadMessages: ThreadMessage[] = [];
    for (const message of messages) {
      const user = message.user ?? message.bot_id ?? message.username;
      if (
        user &&
        message.text &&
        message.ts &&
        isThreadContextMessageSubtype(message.subtype)
      ) {
        threadMessages.push({ user, text: message.text, ts: message.ts });
      }
    }
    return threadMessages;
  }
}

type SlackThreadReply = {
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  subtype?: string;
};

type SlackEventLike = {
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
};

bridgeRegistry.register('slack', (config) => {
  const slackConfig = loadConfig();
  const serverUrl = (
    process.env.SMOLPAWS_COORD_SERVER_URL ?? 'http://127.0.0.1:8790'
  ).replace(/\/+$/, '');
  const sessionApiKey =
    process.env.SMOLPAWS_COORD_SERVER_API_KEY?.trim() || config.runnerToken;
  return new SlackAdapter({
    ...config,
    runnerUrl: serverUrl,
    runnerToken: sessionApiKey,
    slackConfig,
  });
});
