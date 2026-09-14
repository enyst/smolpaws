# Bridges: how they start and what they share

A bridge is one channel's front door. Every bridge on the new stack is a **standalone process** that
attaches to the shared TypeScript OpenHands agent-server through the Message Relay. Nothing runs
"inside the app" anymore; the app is the set of bridges plus one server.

## Process topology

```text
launchd (macOS)
  ├─ com.smolpaws.bridge.whatsapp ─┐
  ├─ com.smolpaws.bridge.slack ────┼─ scripts/run-local-bridge.sh <bridge>
  └─ com.smolpaws.bridge.discord ──┘        │
                                            ├─ health-check http://127.0.0.1:8790/health
                                            ├─ (if down) nohup npm --prefix packages/openhands-agent-server run dev:server
                                            └─ exec npm --prefix apps/<bridge> run start
                                                       │
                               ┌───────────────────────┴────────────────────────┐
                               │ apps/<bridge>                                   │
                               │  platform socket → RelayRuntime (SQLite)        │
                               │    → POST /api/conversations/{id}/events run    │
                               │    → GET  /api/conversations/{id}/events/search │
                               │    → DeliveryTarget → platform send             │
                               └─────────────────────────────────────────────────┘
                                                       │
                                     packages/openhands-agent-server  :8790
                                     (persistence: ~/.smolpaws/conversations)
```

Rules:

- **Any bridge can boot the server.** The launcher starts the agent-server when nothing healthy answers
  on the loopback URL, detached from the bridge, and never stops it. Whichever bridge comes up first
  wins; the others find the server healthy and just attach.
- **Bridges restart independently.** `KeepAlive` on each LaunchAgent restarts a crashed bridge without
  touching the server or the other bridges.
- **One durable store per bridge.** `~/.smolpaws/coordinator/<platform>-relay-v1.db` holds that
  platform's lanes, intake, and delivery rows. Lane keys are `<platform>:<account>:<chat>` and the
  conversation id is derived deterministically from the lane key, so a lane always finds the same
  conversation again and an old EventLog from a different id space is never re-delivered. (Slack keeps
  its earlier `channel:slack:…` keys and `slack-relay:v1` ids so lanes already on disk stay bound.)
- **Deliveries wait for the transport.** A bridge starts its relay worker only once its platform
  client is usable (WhatsApp socket open, Discord `clientReady`, Slack Socket Mode connected), and
  the dispatcher never claims a delivery while the transport is down. A reply queued when the process
  died stays `ready` until the next connection and then goes out once; it is never marked
  `delivery_unknown` because of a send that could not start.
- **The server knows nothing about channels.** Delivery, ordering, retries, and idempotency stay in the
  relay; the server stays upstream-shaped.

## Commands

```bash
npm run bridge:start -- whatsapp                    # foreground: server if needed, then the bridge
npm run bridge:launchagent:install -- whatsapp      # supervised
npm run bridge:launchagent:remove -- whatsapp
npm run slack:relay:local                           # same as bridge:start -- slack
```

Logs: `~/.smolpaws/logs/bridge.<bridge>.launchagent.log`, `~/.smolpaws/logs/openhands-agent-server-8790.log`.

`~/.smolpaws/.env` is loaded by the launcher for every bridge (tokens, `SMOLPAWS_RELAY_SERVER_URL`,
`SMOLPAWS_RELAY_SERVER_API_KEY`, `SMOLPAWS_WORKING_DIR`).

## What every bridge shares

| Concern | Where |
|---|---|
| Durable intake, lane→conversation binding, outbox sync, dispatch loop | `src/coordinator/relayRuntime.ts` (`RelayRuntime`) |
| What counts as deliverable | `src/coordinator/messageRelay.ts` extractors (`terminalResponseExtractor`; WhatsApp adds `sendMessageExtractor`) |
| Agent-server HTTP client, per-lane creation defaults | `src/coordinator/httpAgentServerClient.ts` |
| Workspace + SmolPaws identity context for new conversations | `src/shared/relayConversationDefaults.ts`, `src/shared/smolpawsContext.ts` |
| Launch + supervision | `scripts/run-local-bridge.sh`, `launchd/com.smolpaws.bridge.plist`, `scripts/install-bridge-launchagent.sh` |

### Conversation defaults

When a lane is first seen, the bridge creates the agent-server conversation with:

- `workspace.working_dir`: a real directory. Slack uses `SMOLPAWS_WORKING_DIR`, else
  `SMOLPAWS_WORKSPACE_ROOT/SMOLPAWS_DEFAULT_WORKING_DIR` (default `~/repos/smolpaws`), else this
  checkout. WhatsApp uses `groups/<scope>` under the checkout, per registered chat.
- `tags.ingress`: the bridge name (WhatsApp adds `tags.scope`).
- `agent_launch_additions.system_message_suffix_append`: the SmolPaws identity docs
  (`docs/smolpaws/*.md` except README/HEARTBEAT, plus `~/.smolpaws/memory/MEMORY.md` when present)
  framed as `<SMOLPAWS_CONTEXT>`. This is the upstream agent-server field for deployment context: the
  server resolves the agent from its profile first and only then appends the suffix as the SDK
  `AgentContext.system_message_suffix`, so the cat is paws in every channel without any bridge
  overriding agent settings. Without it the model answers as a generic assistant.

Bridges do not send `agent` at all; the agent and its LLM profile stay the server's choice.

## Status per channel

| Channel | Shape | State |
|---|---|---|
| Slack (`paws`) | standalone relay | live in Liberty Labs; identity context + workspace fix landed with this change |
| WhatsApp | standalone relay | implemented (`apps/whatsapp`), deterministic end-to-end test green; needs the live six-point canary on the Mac, then cutover; scheduler and voice outbox still on the legacy path |
| Discord | standalone relay | rewritten on the relay (`apps/discord`: Gateway → handler → `RelayRuntime` → `DiscordDeliveryTarget`), deterministic end-to-end test green; needs a live check in the test server |
| GitHub, email | Cloudflare Workers → `/turns` on the legacy runner | unchanged; migrate to relay intake after WhatsApp soaks |
| Heartbeat | LaunchAgent → `:8790` | already on the new server |
