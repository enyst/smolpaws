/**
 * Outbound Relay: durable agent events -> delivery outbox -> external dispatch.
 *
 * `syncDeliveryOutbox()` is the catch-up boundary. It may be called repeatedly and is safe because the
 * coordinator owns a durable projection cursor plus idempotent delivery source keys. The relay then asks
 * DeliveryDispatcher to perform bounded external side effects from the durable outbox.
 */
import type { MessageWorkCoordinator } from './coordinator.js';
import type {
  DeliveryDispatchOutcome,
  DeliveryDispatcher,
} from './deliveryDispatcher.js';

export interface OutboundRelayOptions {
  /** Durable/authoritative conversation ids that should be caught up this tick. */
  listConversationIds: () => readonly string[] | Promise<readonly string[]>;
  /** Bound external sends per tick so one busy process does not monopolize the loop. */
  maxDispatchPerTick?: number;
}

export interface OutboundRelayTickResult {
  syncedDeliveries: number;
  dispatched: number;
  syncFailures: ReadonlyArray<{ conversationId: string; error: unknown }>;
  dispatchOutcomes: readonly DeliveryDispatchOutcome[];
}

export class OutboundRelay {
  private readonly maxDispatchPerTick: number;

  constructor(
    private readonly coordinator: MessageWorkCoordinator,
    private readonly dispatcher: DeliveryDispatcher,
    private readonly options: OutboundRelayOptions,
  ) {
    this.maxDispatchPerTick = options.maxDispatchPerTick ?? 32;
  }

  /**
   * Catch up one conversation's durable EventLog into its durable delivery outbox.
   *
   * This is intentionally named as a sync, not a projector: callers care that the outbox is brought up
   * to date, not about the event-sourcing implementation underneath.
   */
  async syncDeliveryOutbox(conversationId: string): Promise<number> {
    return this.coordinator.projectDeliveries(conversationId);
  }

  async tick(worker: string): Promise<OutboundRelayTickResult> {
    let syncedDeliveries = 0;
    const syncFailures: Array<{ conversationId: string; error: unknown }> = [];
    const uniqueConversationIds = new Set(await this.options.listConversationIds());

    for (const conversationId of uniqueConversationIds) {
      try {
        syncedDeliveries += await this.syncDeliveryOutbox(conversationId);
      } catch (error) {
        // One unavailable/corrupt conversation must not prevent already-durable outbox rows for other
        // lanes from being dispatched.
        syncFailures.push({ conversationId, error });
      }
    }

    const dispatchOutcomes: DeliveryDispatchOutcome[] = [];
    let dispatched = 0;
    for (let i = 0; i < this.maxDispatchPerTick; i += 1) {
      const outcome = await this.dispatcher.dispatchNext(worker);
      if (outcome.kind === 'idle') break;
      dispatchOutcomes.push(outcome);
      if (outcome.kind === 'delivered') dispatched += 1;
    }

    return { syncedDeliveries, dispatched, syncFailures, dispatchOutcomes };
  }
}
