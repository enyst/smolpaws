/**
 * FALLBACK idempotent intake append — closes the append-response-loss window WITHOUT changing
 * agent-server (no `event_id` delta).
 *
 * NOTE (Decision D3): this is NOT the primary mechanism. The primary path is the server-side
 * `event_id` idempotency key on `POST /events` (ADR §8, delivered in PR #140), which the coordinator's
 * `integrateNextIntake` uses directly via `AgentServerClient.appendEvent`. This module is retained as a
 * documented, UNWIRED fallback for talking to a server that predates the `event_id` delta. It is fully
 * tested (`idempotentAppend.test.ts`) so it can be wired without a server change if ever needed.
 *
 * Why it exists
 * -------------
 * The ADR's crash matrix has one gap that needs a server change *only if* we insist on a
 * caller-supplied event id: "agent event appended; HTTP response lost". The coordinator appended a
 * user event, the response was lost, it restarts, and it cannot tell "append happened" from "append
 * never happened" — so a blind retry risks a duplicate user turn.
 *
 * Verified upstream reality (agent-sdk `openhands-agent-server`, pinned base commit):
 *   - `POST /events` accepts only `{role, content, run}`; it builds `Message(role, content)` and the
 *     resulting event `id` is a server-generated `uuid4`. `Event`/`MessageEvent`/`TextContent` are all
 *     `extra="forbid"` + `frozen`, so a caller can neither set the id nor smuggle a metadata field.
 *   - `GET /events/search` filters by `kind`, `source`, and a case-insensitive `body` substring, and
 *     `_event_matches_body` matches ONLY a MessageEvent's text content (`content_to_str`).
 *
 * So the only caller-controllable, searchable surface is the message TEXT. Option 2 embeds a compact,
 * deterministic idempotency marker in the appended user message and reconciles the crash window by
 * searching for it before re-appending:
 *
 *   1. search `kind=MessageEvent & source=user & body=<marker>` — did this exact intake already land?
 *      - yes → idempotent no-op; (re)request the run and return `created:false`.
 *      - no  → append the user message with the marker embedded, `run=true`.
 *   2. a lost response / crash before settle → the next attempt's search finds the durable marker and
 *      does NOT double-append.
 *
 * Correctness rests on the coordinator's own claim fence, not on server-side atomicity: `source_key` is
 * UNIQUE in the work table (one intake row per platform message) and only one fenced worker integrates
 * that row at a time, so the only re-append is the *sequential* crash-retry of the same item — never two
 * concurrent appends. "Search-then-append" is therefore safe here even though it is not atomic. It also
 * relies on agent-server persisting the event durably before returning (its EventLog already does), so a
 * retry after a lost response reliably observes the marker.
 *
 * Cost, stated honestly: the marker is visible in the user message the model sees. We keep it maximally
 * seamless — a single trailing HTML comment (`<!-- oh-idem:… -->`), which models overwhelmingly ignore,
 * placed AFTER the original text so the real content leads. There is no field that is both
 * caller-settable and hidden from the model; this is the least-intrusive robust option without a server
 * change. See {@link idempotencyMarker} for the marker itself.
 */

/** A minimal LLM text content block, matching the SDK `TextContent` wire shape. */
export interface TextContentBlock {
  type: 'text';
  text: string;
}

/**
 * Deterministic, compact idempotency marker for one inbound message. Derived from the deterministic
 * agent event id the coordinator already computes (`uuidv5(platform + source_message_id)`), so two
 * distinct platform messages with identical text still get distinct markers — the reason a marker beats
 * naive content-equality matching. 12 hex chars of a UUIDv5 is collision-safe per (conversation, user).
 */
export function idempotencyMarker(agentEventId: string): string {
  const compact = agentEventId.replace(/-/g, '').slice(0, 12);
  return `oh-idem:${compact}`;
}

/** The marker rendered as a single, model-seamless trailing content block (an HTML comment). */
export function markerBlock(marker: string): TextContentBlock {
  return { type: 'text', text: `<!-- ${marker} -->` };
}

/**
 * Attach the marker to message content without disturbing the original. Accepts the two shapes the
 * coordinator stores as an intake payload — a bare string or an array of content blocks — and always
 * returns a content-block array with the original leading and exactly one marker block trailing.
 */
export function withMarker(content: unknown, marker: string): unknown[] {
  const original: unknown[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content } satisfies TextContentBlock]
      : Array.isArray(content)
        ? [...content]
        : content == null
          ? []
          : [content];
  return [...original, markerBlock(marker)];
}

/**
 * The narrow agent-server surface the idempotent appender needs. Kept strictly upstream-shaped: append a
 * user message (server owns the event id), search user messages by marker, request a run. Backed in
 * production by {@link HttpAgentServerClient}; faked with an upstream-accurate in-memory server in tests.
 */
export interface IdempotentAppendPort {
  /** Append a user message via `POST /events` (`{role:'user', content, run}`); server assigns the id. */
  appendUserMessage(conversationId: string, content: unknown[], run: boolean): Promise<void>;
  /** True iff a durable user MessageEvent already carries this marker (`search?source=user&body=`). */
  hasUserMessageWithMarker(conversationId: string, marker: string): Promise<boolean>;
  /** Request a run (idempotent; "already running" is not an error). */
  run(conversationId: string): Promise<void>;
}

export interface IdempotentAppendResult {
  /** `false` when the search found the marker already present — the append was an idempotent no-op. */
  created: boolean;
  marker: string;
}

/**
 * Search-then-append intake integration that is crash-safe against a server which ignores caller event
 * ids (i.e. real upstream). Drop-in replacement for the `appendEvent` step inside
 * `MessageWorkCoordinator.integrateNextIntake`, requiring no ADR §8 server delta.
 */
export class IdempotentIntakeAppender {
  constructor(private readonly port: IdempotentAppendPort) {}

  /**
   * Idempotently ensure the deterministic user event exists and (if `run`) that execution was requested.
   *
   * @param agentEventId the coordinator's deterministic id for this message; only used to derive the marker.
   */
  async append(
    conversationId: string,
    agentEventId: string,
    content: unknown,
    run: boolean,
  ): Promise<IdempotentAppendResult> {
    const marker = idempotencyMarker(agentEventId);

    // 1. Reconcile the append-response-loss window: has this exact intake already landed durably?
    if (await this.port.hasUserMessageWithMarker(conversationId, marker)) {
      // The event exists; the only thing that might have been lost is the run request — re-issue it.
      // Requesting a run is itself idempotent: active means already executing, idle schedules it.
      if (run) await this.port.run(conversationId);
      return { created: false, marker };
    }

    // 2. Not present → append with the embedded, searchable, seamless marker. If the response is lost
    //    here, step 1 of the next attempt finds the durable marker and this never double-appends.
    await this.port.appendUserMessage(conversationId, withMarker(content, marker), run);
    return { created: true, marker };
  }
}
