# Slack Coordinator Canary Operations

These instructions run the real `paws` Slack app through the durable coordinator path and the TypeScript OpenHands agent-server.

The Slack app is greenfield. It does not require the legacy SmolPaws `/turns` server on port 8788.

## Prerequisites

- Node.js 20 or newer;
- the repository checked out locally;
- the `paws` Slack app installed in the target workspace;
- Socket Mode enabled;
- a bot token and app-level Socket Mode token;
- the bot scopes and event subscriptions listed below;
- a usable LLM profile and provider credential available to the TypeScript agent-server.

## Slack app configuration

### Bot token scopes

Use only the scopes the implementation needs:

- `app_mentions:read`
- `chat:write`
- `im:history`
- `reactions:write`
- `channels:history` when channel-thread follow-ups/context are enabled

Private-channel support additionally requires the corresponding private-channel scopes and an explicit decision to enable it.

### Event subscriptions

Subscribe the bot to:

- `app_mention`
- `message.im`
- `message.channels` when channel-thread follow-ups are enabled

Socket Mode means no public request URL or tunnel is required.

## Install dependencies

From the repository root:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack
```

## Environment

Put local values in `~/.smolpaws/.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# New upstream-shaped TypeScript server
SMOLPAWS_COORD_SERVER_URL=http://127.0.0.1:8790

# Set only when the server requires session auth
SMOLPAWS_COORD_SERVER_API_KEY=...

# Optional allowlists
SLACK_ALLOWED_TEAM_IDS=T12345
SLACK_ALLOWED_CHANNEL_IDS=C12345,D12345
SLACK_ALLOWED_USER_IDS=U12345
```

Never commit token values. The coordinator database must contain message/work metadata only, not provider or Slack credentials.

The Slack coordinator database is currently fixed at:

```text
~/.smolpaws/coordinator/slack.db
```

## Start the TypeScript agent-server

The helper script loads `~/.smolpaws/.env` before executing the supplied command:

```bash
./scripts/run-local-smolpaws.sh \
  npm --prefix packages/openhands-agent-server run dev:server
```

Defaults:

```text
host: 127.0.0.1
port: 8790
```

Override them only when necessary:

```bash
OPENHANDS_AGENT_SERVER_HOST=127.0.0.1
OPENHANDS_AGENT_SERVER_PORT=8790
```

Verify the server before starting Slack:

```bash
curl -fsS http://127.0.0.1:8790/health
```

## Start paws

In a second process:

```bash
./scripts/run-local-smolpaws.sh \
  npm --prefix apps/slack run start
```

The startup log should say that the Slack bot is ready on the coordinator path and identify the new agent-server URL.

For local development with reload:

```bash
./scripts/run-local-smolpaws.sh \
  npm --prefix apps/slack run dev
```

## Focused checks

```bash
npm run typecheck --prefix apps/slack
npm run test --prefix apps/slack
```

The dedicated GitHub Actions job is named `slack-coordinator`. It intentionally gives this canary an honest signal even while unrelated agent-server parity debt may keep the repository-wide check red.

## Live test procedure

Use a non-critical channel in the Liberty Labs workspace.

1. Start the TypeScript agent-server on port 8790.
2. Start the Slack app from the checkout containing the candidate commit.
3. Mention `paws` with a unique response token.
4. Confirm paws replies in the correct Slack thread.
5. Confirm the running checkout contains the expected commit.
6. Confirm the new server health endpoint is reachable.
7. Confirm coordinator intake and delivery evidence exists.

The source key for a Slack event is:

```text
slack:{team_id}:{channel_id}:{message_ts}
```

Useful read-only SQLite inspection with the root dependency installation:

```bash
node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const db = new Database(path.join(os.homedir(), '.smolpaws/coordinator/slack.db'), {
  readonly: true,
});

console.log('lanes');
console.table(db.prepare(`
  SELECT lane_key, conversation_id, conversation_ready, last_seen_at
  FROM lanes
  WHERE platform = 'slack'
  ORDER BY last_seen_at DESC
  LIMIT 10
`).all());

console.log('work');
console.table(db.prepare(`
  SELECT kind, source_key, state, conversation_id, agent_event_id,
         send_attempted, external_message_id, last_error, updated_at
  FROM work
  WHERE lane_key LIKE 'channel:slack:%'
  ORDER BY updated_at DESC
  LIMIT 20
`).all());
NODE
```

For one canary, verify:

- the `intake` row reaches `done`;
- its `conversation_id` exists in the server;
- a corresponding `delivery` row is created;
- the delivery reaches `done`;
- `send_attempted` is true;
- `external_message_id` contains the Slack message timestamp.

If a delivery reaches `delivery_unknown`, do not manually set it ready and retry without first checking Slack. The original send may already have succeeded.

## Restart behavior

The coordinator state survives process restarts. On startup, the runtime:

- reconciles expired intake claims that are safe to retry;
- preserves ambiguous delivery sends as `delivery_unknown`;
- resumes event-to-outbox catch-up from durable cursors;
- dispatches already-durable delivery rows in lane order.

The in-memory mentioned-thread tracker does not survive restart. After a restart, mention paws once in an existing channel thread before relying on mention-free follow-ups there.

## Troubleshooting

### Paws replies through the wrong architecture

A reply containing the legacy fallback text:

```text
🐾 Done — nothing to report back.
```

is evidence that an older process is still using `BaseBridgeAdapter`'s `/turns` dispatch. Pull the candidate checkout and restart the Slack process before treating the test as a coordinator canary.

### Port 8790 is unavailable

Start `packages/openhands-agent-server` with `dev:server` and inspect its logs. Do not silently redirect Slack back to port 8788.

### Intake is present but no delivery appears

Check the agent-server EventLog and confirm the run reached a terminal `finish` observation. The first canary extracts that terminal response into the delivery outbox.

### Delivery is `delivery_unknown`

Inspect the Slack thread for the expected message and reconcile deliberately. Automatic blind retry is intentionally disabled after an external send may have begun.
