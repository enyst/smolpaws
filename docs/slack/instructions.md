# Slack App Setup Notes

These notes are for the planned real Slack app, not the current Chrome workaround.

## Intended Local Development Mode

Use a local Slack app process with Socket Mode.

That means:

- Slack connects to the app over WebSocket
- the app connects locally to the shared SmolPaws runner
- no public webhook URL is required
- no Cloudflare Worker is required for Slack ingress

## Workspace Setup

1. Create a Slack app for the target workspace.
2. Enable a bot user.
3. Enable Socket Mode.
4. Generate an app-level token for Socket Mode.
5. Install the app to the workspace.
6. Add only the scopes needed for the current implementation phase.

Important:

- whether you can install it yourself depends on that workspace's app-approval policy
- for a locked-down workspace, an admin or owner may need to approve or install the app

## First Scopes / Events

The planned first cut should use:

- bot scopes:
  - `app_mentions:read`
  - `chat:write`
  - `im:history`
- bot events:
  - `app_mention`
  - `message.im`

Only add broader history scopes if we actually implement and want channel-thread context.

## Local Env

Planned local env variables:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SMOLPAWS_RUNNER_URL=http://127.0.0.1:8788
SMOLPAWS_RUNNER_TOKEN=...
SLACK_ALLOWED_TEAM_IDS=T12345
SLACK_ALLOWED_CHANNEL_IDS=C12345,D12345
SLACK_ALLOWED_USER_IDS=U12345
```

Put these in `~/.smolpaws/.env` so the local launcher can load them.

## Planned Local Commands

Once the app exists, the expected shape should be:

```bash
npm --prefix apps/slack install
npm --prefix apps/slack run dev
npm --prefix apps/slack run test
```

If we want it always-on, add a LaunchAgent after the manual flow is stable.

## Smoke Test Checklist

After implementation, test in this order:

1. DM the Slack app directly.
2. Confirm a local `slack-im-*` conversation appears under `~/.openhands/conversations`.
3. Confirm the app replies in the same DM.
4. Mention the app in a playground channel.
5. Confirm a local `slack-thread-*` or `slack-channel-*` conversation appears.
6. Confirm the reply lands in the correct Slack thread.

## Migration Note

The current Chrome Slack path should remain available only as a temporary fallback while the real app is being built and verified.

The goal is to remove it from normal operations after the Socket Mode app is stable.
