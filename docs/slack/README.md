# Slack Coordinator Relay Architecture

Slack is the first greenfield bridge for SmolPaws' durable message-work path.

It intentionally does **not** preserve the unused legacy Slack implementation, inherit the shared bridge adapter, or route messages through the old `/turns` runner. Slack runs as its own Socket Mode process beside the upstream-shaped TypeScript agent-server.

## Current flow

```text
Slack Socket Mode
  -> SlackBridge / slackHandler
  -> SlackCoordinatorRuntime.accept()
  -> durable coordinator intake in SQLite
  -> TypeScript OpenHands agent-server on :8790
  -> durable agent EventLog
  -> OutboundRelay.syncDeliveryOutbox()
  -> durable delivery outbox
  -> DeliveryDispatcher
  -> SlackDeliveryTarget
  -> chat.postMessage
```

The ingress success boundary is durable acceptance, not an in-memory request finishing. A reply may be produced later by the Relay after a process delay or restart.

## Component boundaries

### `apps/slack/src/adapter.ts`

`SlackBridge` owns the Bolt Socket Mode lifecycle, event subscriptions, bot-loop guards, and Slack API wiring. It is standalone and cannot silently fall back to `/turns`.

`apps/slack/plugin.json` is marked `kind: "standalone"`, so the old shared bridge loader deliberately ignores it. Discord and other existing bridges remain on their current shared lifecycle until reviewed separately.

### `apps/slack/src/slackHandler.ts`

Owns Slack-specific ingress policy:

- workspace/channel/user allowlists;
- guest limits;
- mention stripping;
- bounded thread context;
- Slack conversation identity;
- acknowledgement reactions;
- a short-lived process-local duplicate gate.

The duplicate gate is not the durable idempotency authority. It reserves an event only while acceptance is in flight, commits it after SQLite acceptance, and releases it on failure so Slack retries remain useful.

### `apps/slack/src/coordinatorRuntime.ts`

Hosts the current Slack canary workers:

1. durably accepts normalized Slack messages;
2. integrates ready intake into the new agent-server with deterministic event IDs;
3. reconciles expired claims and retry waits;
4. calls `syncDeliveryOutbox()` for known Slack conversations;
5. asks the Delivery Dispatcher to perform bounded external sends.

The first authoritative Relay generation persists state at:

```text
~/.smolpaws/coordinator/slack-relay-v1.db
```

It derives agent-server conversation IDs from the versioned namespace `slack-relay:v1`. Both identities are intentionally separate from the earlier shadow experiment, preventing initial catch-up from rediscovering and sending old shadow responses.

### `src/coordinator/outboundRelay.ts`

`OutboundRelay` coordinates the outbound half without owning platform behavior.

Its public catch-up operation is:

```ts
syncDeliveryOutbox(conversationId)
```

The coordinator exposes the same name. The older `projectDeliveries()` method remains only as a deprecated compatibility alias for code outside the Slack canary.

The sync reads new durable agent events and brings the delivery outbox up to date. It is cursor-based, replay-safe, and safe to call repeatedly.

### `src/coordinator/deliveryDispatcher.ts`

`DeliveryDispatcher` owns the external side-effect boundary:

```text
claim
  -> validate target and payload
  -> durably mark send_attempted
  -> call platform DeliveryTarget
  -> settle done / failed / delivery_unknown
```

Validation happens before `send_attempted`. Once sending may have begun, an exception is treated conservatively as `delivery_unknown`; the system does not blindly repeat an effect that may already have reached Slack.

### `apps/slack/src/deliveryTarget.ts`

`SlackDeliveryTarget` translates a durable Slack lane plus a delivery payload into `chat.postMessage` calls. It preserves the lane's channel and `thread_ts`, splits long messages, and returns Slack's message timestamp as the external message ID.

### `packages/openhands-agent-server`

The new TypeScript agent-server remains the source of truth for conversations, durable events, and agent execution. Queue, retry, platform delivery, and lane semantics stay outside it.

## Identity and idempotency

A Slack event uses the stable source-message identity:

```text
{channel_id}:{message_ts}
```

The coordinator combines it with the Slack workspace when constructing the durable intake source key and derives a deterministic agent event ID. Replaying the same Slack event therefore converges on the existing intake work and existing agent event rather than creating another turn.

One external Slack conversation maps to one durable coordinator lane:

```text
channel:slack:{team_id}:{channel_id}:{thread_ts-or-root}
```

- DMs use `root`.
- A channel mention starts or joins a Slack thread.
- Replies in a tracked thread reuse its root `thread_ts`.
- The lane directory persists the mapping to one versioned agent-server conversation ID.

## Outbound policy

The first authoritative Slack canary delivers the normal terminal `finish` observation as the chat reply. A normal Slack answer does not require the agent to call a Slack-specific `send_message` tool.

The extractor policy remains replaceable. Explicit outbound-intent events can later support richer multi-message behavior without changing the durable dispatcher.

## Slack behavior retained

The redesign keeps the parts that are genuinely Slack concerns:

- Socket Mode via `@slack/bolt`;
- DMs and `app_mention` events;
- thread replies after a thread has mentioned paws;
- bounded `conversations.replies` context;
- access controls and guest limits;
- acknowledgement reactions;
- long-message splitting.

The mentioned-thread tracker is currently in memory and resets when the process restarts. It is updated only after durable intake acceptance. Durable execution and delivery do not depend on it after a message has crossed the SQLite boundary.

## Configuration

The local configuration lives in `~/.smolpaws/.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SMOLPAWS_COORD_SERVER_URL=http://127.0.0.1:8790
SMOLPAWS_COORD_SERVER_API_KEY=...

# Optional policy
SLACK_ALLOWED_TEAM_IDS=T12345
SLACK_ALLOWED_CHANNEL_IDS=C12345,D12345
SLACK_ALLOWED_USER_IDS=U12345
```

The agent-server must have a usable active LLM profile and credential in its own state/keychain. Raw provider credentials do not belong in coordinator SQLite or Slack delivery rows.

## Running the canary

Install dependencies:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack
```

Start the new server:

```bash
./scripts/run-local-smolpaws.sh npm --prefix packages/openhands-agent-server run dev:server
```

Then start paws as a separate process:

```bash
./scripts/run-local-smolpaws.sh npm --prefix apps/slack run start
```

Do not rely on the old `apps/agent-server` process to host Slack. The standalone process boundary is part of the canary architecture.

## Verification

The focused Slack workflow runs:

```bash
npm run typecheck --prefix apps/slack
npm run test --prefix apps/slack
```

The tests cover:

- durable Slack lane derivation;
- delivery-target channel and thread routing;
- outbox catch-up and replay behavior;
- successful delivery settlement;
- `delivery_unknown` after an ambiguous external failure;
- failed durable acceptance followed by a successful Slack retry;
- concurrent duplicate suppression while acceptance is in flight;
- a deterministic end-to-end run through the real in-process TypeScript agent-server, fake LLM `finish`, real SQLite, Outbound Relay, Delivery Dispatcher, and Slack Delivery Target.

A real live canary requires evidence from every boundary:

1. the Slack event is accepted;
2. the intake row exists in `slack-relay-v1.db`;
3. the new agent-server contains the deterministic user event and completed run;
4. `syncDeliveryOutbox()` creates delivery work;
5. Delivery Dispatcher settles it with Slack's timestamp as `external_message_id`;
6. the reply appears in the correct Slack thread or DM.

A visible Slack reply alone is not enough proof because an older local process may still be running legacy code. In particular, `🐾 Done — nothing to report back.` is the old `/turns` fallback and proves that the Relay canary did **not** handle that message.

## Rollout boundary

Slack is the non-critical canary for the full coordinator path. The old Slack implementation had no production compatibility obligation, so this app establishes the clean interface other bridges may later adopt.

Do not migrate WhatsApp, Discord, or other bridge behavior merely by copying Slack. Their existing usage and platform semantics must be reviewed separately before cutover.
