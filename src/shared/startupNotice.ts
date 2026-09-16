import type { Logger } from 'pino';

export const STARTUP_NOTICE = "🐾 I'm up.";

/**
 * One best-effort announcement per bridge instance, after its transport and runtime are ready.
 * Adapters choose authorized destinations and retain this instance across socket reconnects.
 * An uncertain send is not retried or put in the conversation outbox, where it could block replies.
 */
export class StartupNotice {
  private notification: Promise<void> | undefined;

  constructor(private readonly logger: Logger) {}

  notify(
    targetIds: Iterable<string>,
    send: (id: string, text: string) => Promise<unknown>,
  ): Promise<void> {
    if (this.notification !== undefined) return this.notification;
    const destinations = [...new Set([...targetIds].map(id => id.trim()).filter(Boolean))];
    // Defer sends until the promise is stored, including a callback that synchronously re-enters us.
    this.notification = Promise.resolve().then(async () => {
      await Promise.all(destinations.map(async (targetId) => {
        try {
          await send(targetId, STARTUP_NOTICE);
        } catch (error) {
          this.logger.warn(
            { targetId, err: error instanceof Error ? error.message : String(error) },
            'Bridge startup notification failed',
          );
        }
      }));
    });
    return this.notification;
  }
}
