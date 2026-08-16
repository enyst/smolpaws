# Slack App

Local Socket Mode canary for the durable SmolPaws message-work architecture.

## Current architecture

Slack is deliberately greenfield. It does **not** use the legacy `/turns` runner path.

```text
Slack Socket Mode
  -> SlackAdapter / slackHandler
  -> SlackCoordinatorRuntime.accept()
  -> coordinator durable intake (SQLite)
  -> TypeScript OpenHands agent-server (:8790)
  -> agent EventLog
  -> OutboundRelay.syncDeliveryOutbox()
  -> durable delivery outbox
  -> DeliveryDispatcher
  -> SlackDeliveryTarget
  -> chat.postMessage
```

The shared `BaseBridgeAdapter` is retained only for bridge-loader lifecycle compatibility. `SlackAdapter.dispatch()` overrides its legacy dispatch behavior completely; do not reintroduce `turnClient` or `/turns` into `apps/slack`.

## Ownership

- `slackHandler.ts`: Slack ingress policy, normalization, access control, thread context and dedup.
- `coordinatorRuntime.ts`: Slack-hosted coordinator workers for the current canary; durable acceptance is the ingress success boundary.
- `src/coordinator/outboundRelay.ts`: catches durable agent events up into the delivery outbox through `syncDeliveryOutbox()`.
- `src/coordinator/deliveryDispatcher.ts`: claims delivery work, marks the external-send fence, invokes the target, and settles the durable outcome.
- `deliveryTarget.ts`: Slack-specific `chat.postMessage` side effect using the lane's durable channel/thread coordinates.
- `packages/openhands-agent-server`: source of truth for conversation events and agent execution.

## Delivery rule

The canary projects the normal terminal `finish` observation as a Slack reply. Slack does not require an agent-specific `send_message` tool merely to produce a normal chat response.

Once a delivery row has been durably marked `send_attempted`, an exception is treated as `delivery_unknown`; the dispatcher does not blindly retry an external effect that may already have landed.

## Local canary

Install the root, new agent-server package, and Slack dependencies:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack
```

Start the TypeScript agent-server:

```bash
./scripts/run-local-smolpaws.sh npm --prefix packages/openhands-agent-server run dev:server
```

It listens on `127.0.0.1:8790` by default. Then start paws:

```bash
./scripts/run-local-smolpaws.sh npm --prefix apps/slack run start
```

Relevant environment variables in `~/.smolpaws/.env`:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SMOLPAWS_COORD_SERVER_URL` (default `http://127.0.0.1:8790`)
- `SMOLPAWS_COORD_SERVER_API_KEY` when agent-server auth is enabled
- optional Slack team/channel/user allowlists
- optional `SMOLPAWS_COORD_DB` is no longer used by this Slack canary; its current durable DB is `~/.smolpaws/coordinator/slack.db`

The new server must also have a usable active LLM profile/credential in its server state/keychain.

## Tests

```bash
npm run typecheck --prefix apps/slack
npm run test --prefix apps/slack
```

The delivery-pipeline tests cover durable outbox sync, fenced dispatch, `delivery_unknown`, Slack channel/thread routing, and terminal-response relay behavior with real SQLite.

## Liberty Labs canary

The Slack app identity is `paws`. Use the Liberty Labs workspace as the non-critical live canary. Verify one message by checking all of:

1. Slack ingress event is accepted.
2. an `intake` row exists in `~/.smolpaws/coordinator/slack.db`;
3. the new agent-server contains the deterministic user event and a completed agent run;
4. `syncDeliveryOutbox()` creates the corresponding `delivery` row;
5. Delivery Dispatcher settles it `done` with the Slack message timestamp as `external_message_id`;
6. the reply appears in the correct Slack DM/thread.

Do not infer success merely because Slack shows a reply; the durable work rows and new agent-server EventLog are part of the end-to-end contract.

## Thread follow-ups

Once paws is mentioned in a thread, subsequent replies in that thread are accepted without another mention. The tracker is currently in-memory and resets on process restart.
