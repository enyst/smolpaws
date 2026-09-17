# WhatsApp production status and cutover history

Updated 2026-09-17. The normal deployment is the standalone WhatsApp bridge on the shared SmolPaws
product host at `http://127.0.0.1:8790`. The September 15–16 sections below are historical canary
observations, not instructions to leave another host running on `:8791`.

## September 17 production promotion

The normal bridge connected at **02:48:56 Stockholm time on September 17, 2026**
(00:48:56 UTC). The shared product host on `:8790` reported SmolPaws `dc064a2`, including
[the concurrent-input history correction (#200)](https://github.com/smolpaws/smolpaws/pull/200).
The canary services and legacy WhatsApp service were stopped and disabled; no listener remained
on `:8791`.

Promotion retained the canary's existing conversations, profiles, context snapshots, scheduled tasks,
and delivery progress. Their state now lives in the normal private SmolPaws directories alongside
the conversations already on the shared host. Main kept its conversation; there was no message
replay or new WhatsApp pairing.

| Component | Normal deployment |
|---|---|
| Product host | `com.smolpaws.relay-server`, listening on loopback `:8790` |
| WhatsApp bridge | `com.smolpaws.bridge.whatsapp`, using that shared product host |
| Retired canary | `com.smolpaws.canary.server` and `com.smolpaws.canary.whatsapp` disabled; `:8791` retired |
| Legacy WhatsApp | `com.smolpaws` stopped and disabled; reference/rollback code remains in the checkout |
| Current conversations | `~/.smolpaws/conversations/<uuid>/events/`, with conversation metadata and saved context beside the event directory |
| Legacy Main transcripts | `~/.openhands/conversations/main-*/events.jsonl`; retained separately, not converted into the current conversations |
| WhatsApp relay | `~/.smolpaws/coordinator/whatsapp-relay-v1.db` |
| Shared scheduler | `~/.smolpaws/coordinator/scheduler.db` |
| Native API relay | `~/.smolpaws/coordinator/agent-server-relay-v1.db`; separate from every bridge's relay store |

The existing WhatsApp auth directory and message ledger stay under `~/.smolpaws/whatsapp/`.
Chat registration, [named model selection](../models.md), and [always-on context](../context-files.md)
use the normal private configuration under `~/.smolpaws`. Main, OpenHands, and Hunting keep their
scope folders and trigger policy. The scheduler retains task and occurrence identities, including
isolated conversations; the Slack mention poll continues to wake OpenHands.

The completed preservation and startup checks recorded:

- **43 conversations:** 23 moved from the canary plus the shared host's existing 20, with their
  conversation IDs retained. API profile bindings, workspaces, and accumulated metrics/statistics
  matched the pre-promotion values.
- **2,580 event files and 20 context snapshots** preserved byte for byte. Conversation metadata
  changed only where needed for the new persistence location.
- **29 scheduled tasks, 15 recorded runs, 22 registered scheduler lanes, 5 command receipts, and
  1 legacy-import marker** retained, including isolated scheduled conversations.
- **201 WhatsApp work rows**, all `done`, with relay identities, projection cursors, recovery state,
  and outbound media preserved.
- The normal bridge connected and loaded its registered chats; the shared product host was healthy.

These checks establish preservation and service readiness. They do not claim a new user-confirmed
WhatsApp reply after promotion. The earlier iPad text/image/voice confirmations remain dated canary
evidence below.

For rollback, use the **latest production state** and the handoff procedure below. A frozen copy of
the old canary is a backup, not an up-to-date replacement: restoring it after new production work
would lose conversations or tasks and could replay already delivered effects. Keep the retired
canary and legacy LaunchAgents disabled unless deliberately transferring ownership while stopped.

## Historical implementation and September 15 preflight

Status recorded on 2026-09-16. The standalone bridge included the history handoff (`kxa.6`), shared
scheduler (`kxa.4`), outbound media/voice (`kxa.2`), existing scope rules (`kxa.8`), recovery (`kxa.9`) and bounded
HTTP intake (`39y`). The canary product host was verified at SmolPaws `28106cd` on September 16,
vendoring SDK `a983e4c`: subscription OAuth, bridge tools, provider compatibility, multi-tool and
concurrent-input history fixes, and provider usage metrics. Beads owns completion and deployment status.

Real-provider preflight passed on 2026-09-15: SmolPaws `7a98ef1`, SDK `573ec5d`, the configured
`deepseek-v4-flash` profile and its normal Keychain reference. A temporary real product host verified
the product header and completed two consecutive turns, each with a `list_tasks` observation and
`finish` carrying the expected marker. No bridge socket, live WhatsApp send or service swap was used.
A bounded connection trial followed on 2026-09-15, 05:39–05:49 UTC: an isolated product host on
`:8791` ran SmolPaws `822bb24` with SDK `775869e`, the same active profile and separate persistence.
Its provider validation passed; the bridge reused the existing account with only Main allowlisted,
startup ping disabled and zero offline messages. No test input arrived and the relay stayed empty.
The drain/handoff check passed and the updated legacy bridge reconnected with its scheduler running.
This proves connection and an empty-work rollback, **not** a live reply or recovery under load.

The trial also exposed an inherited relay database override: the native host must use a separate
work store from its launching bridge. `SMOLPAWS_AGENT_SERVER_RELAY_DB_PATH` now owns the native
override; `SMOLPAWS_RELAY_DB_PATH` remains bridge-specific. The trial used separate stores before
opening the socket. The existing bare `:8790` server was unchanged during that trial. At that point,
the remaining gates were the final deployed product-host check (`kxa.7`), live one-chat canary (`kxa.5`) and production soak.
The evening evidence below closed the first two; overnight soak was the remaining gate at that point.
See [shared design](../bridges.md) and [architecture page](https://enyst.github.io/arch/whatsapp-readiness.html).

## Historical: September 15 iPad canary

During 18:19–18:30 UTC, the iPad input reached the ledger and durable relay. A 422 exposed an
oversized launch suffix (64,997 characters versus upstream’s 32,768 cap). Product fix #175 keeps
identity inline and references oversized files for reading; the corrected Main suffix was 18,300
characters. Retrying the original intake completed the agent run. The user confirmed text replies
on the iPad, but two identical outputs exposed the `send_message` plus `finish` echo (bead 955).

A real image and OGG/Opus voice note were queued while the bridge was stopped. Both remained
`ready` with no send attempt, then reached `done` with external WhatsApp IDs after reconnect. The
user confirmed the image and playable voice. The agent failed before scheduling: a two-tool response
duplicated its thought into both ActionEvents, and SDK history reconstruction rejected the next
step (bead 956). SDK #32 repairs construction against pinned Python; fresh history is required or
old malformed events must be explicitly reconciled without repeating completed effects.

All delivered effects were accounted for, the unfinished scheduling request was abandoned, and
rollback restored legacy at 18:30:20 UTC with its scheduled tasks unchanged. This trial proves text,
media playback and queued-media restart, not scheduled delivery or permanent replacement. The user
authorized leaving the corrected Main-only canary running overnight.

## Historical: September 15 overnight canary

The Main-only bridge connected at 18:49:36 UTC on merged SmolPaws `c4ba8c4` with SDK `5f28eb8`,
using the existing `deepseek-v4-flash` profile. Separate bridge/native relay stores and fresh server
persistence avoid the earlier malformed history. The product host passed a real-provider two-tool
batch (`list_tasks` and `think`), then continued its saved conversation after a process restart.

An operator request through the actual Main conversation deliberately used `send_message` and
`finish` with identical text. Fix #176 produced one `NIGHT-CANARY READY` delivery. Its once task
then produced one `NIGHT-SCHEDULE OK` delivery. Each reached `done` with one send attempt and an
external message ID; the user confirmed one visible copy of each on the iPad. This scheduled test
was a direct operator request, while the earlier text test was real WhatsApp ingress. Offline replay
of that captured intake at the relay acceptance boundary preserved the same completed work row
without another server call or platform send.

At that stage, the canary host and WhatsApp bridge ran under dedicated KeepAlive LaunchAgents.
Legacy WhatsApp was stopped and disabled so it could not compete for the device after reboot; its
updated code remained available for rollback. Existing Main tasks were preserved. The next Main
cron was due September 16 at 07:00 UTC. Other local servers and ingress services were left unchanged.

Deployment and controlled-canary beads `kxa.7` and `kxa.5` closed with that trial. Overnight
observation was tracked as `smolpaws-957`; promotion status is recorded at the top of this page and
in Beads. All-ingress retirement is separate work (`b1r.24`). These are timestamped observations,
not a promise of continuous monitoring. The private runtime directory contains the
exact service configuration, evidence and rollback procedure; never restore old auth or ledger
snapshots over progress made during the canary.

## Historical: September 16 scope expansion — OpenHands replies verified

The user authorized adding the two existing legacy groups, OpenHands and Hunting, alongside Main
in the overnight canary. Both additional groups keep `triggerFree: true`, so ordinary text can
trigger replies without an `@smolpaws` mention. Their existing scope folders remain distinct;
neither becomes the control scope. Main retains its control permissions and private-memory context.

The selected canary registration file then contained exactly these three chats, retaining the legacy
entries. At 00:46:35.891 Stockholm time on September 16 (September 15, 22:46:35.891 UTC), the running
bridge logged `Registered WhatsApp chats loaded` with count 3. No restart was needed. This expanded
the selected file, rather than merging every legacy registration. See [Register chats](README.md#3-register-chats)
for file precedence, hot reload and the supported per-chat fields. At that point, new conversations
used the active server profile. Current per-scope profile selection is documented in
[model configuration](../models.md); adding a registration alone does not choose a profile.

Both added groups had zero undispatched saved messages and no active legacy scheduled tasks at the
check. Registration reload does not import their legacy schedules; that import occurs at runtime
startup. No synthetic WhatsApp test or message replay was sent. Two new OpenHands messages at
00:48:49 and 00:49:12 Stockholm time each completed one intake and one reply delivery, with a single
send attempt, a distinct external WhatsApp message ID and no recorded error. Transport accepted the
replies at 00:48:55 and 00:49:24; this does not claim a separate user confirmation of display.
Hunting was enabled but still awaited a new test message at that check. A message received while
its chat was excluded was not saved by the bridge for later recovery. The expansion was part of
the overnight soak (`smolpaws-957`), not a declaration of permanent cutover or all-ingress retirement.

## Implemented and tested

| Capability | Behavior and evidence |
|---|---|
| History | Import the actual legacy `data/router_state.json` once into per-message identity progress in the ledger. Preserve pending, same-second and late arrivals; duplicate inserts cannot reset progress. Both updated host generations use that journal. `historyHandoff.test.ts`. |
| Isolation | One process lock per auth directory; explicit ledger/relay/allowlist paths; startup-ping control; refuse persisted lanes outside the allowlist. A persisted relay owner tag rejects adoption of an unrelated server EventLog. `historyHandoff.test.ts`, HTTP tests. |
| Scheduler | One shared SQLite store, real task-tool observations, scoped lifecycle commands, cron/interval/once, group/isolated runs and idempotent synthetic intake. Real profile/server tests across WhatsApp, Slack, Discord and direct API conversations. |
| Media | Immutable local spool and durable delivery rows; image/video/audio/document delivery. WhatsApp OGG/Opus PTT and the existing private `voice-outbox.jsonl` producer are supported. Outbound IDs suppress media echoes on the shared account. File and symlink scope checks; fake transport tests. |
| Scope | WhatsApp `groups/<folder>` and existing control semantics: `main` can manage tasks across scopes; other scopes see/manage their own. Product context configuration explicitly selects always-on identity and private memory for authorized scopes; each conversation retains its saved snapshot. No new sandbox or delegation model. |
| Recovery | Durable acceptance requires no server request. HTTP deadlines include response bodies; interrupted tool outcomes are parked; disconnected delivery waits; timed-out sends stay `delivery_unknown`; reconnect creation retries; one shared child supervisor restarts the server. |

The deterministic tests use fake platform transports and a test LLM with the real TypeScript
server/agent. They prove the local path, not provider availability or live media playback.

The canonical packed SDK subscription path also passed on 2026-09-15 using the existing OpenHands
OAuth account and `gpt-5.5`: profile preflight, two `think`/`finish` tool round trips and continuation,
with temporary server state and no bridge sends. `authType: "subscription"` profiles use the SDK's
private credential store; the deployed active model was not changed. The server-side device-login
endpoints and restart/refresh path have deterministic HTTP and persisted-conversation coverage.
See [subscription architecture](../../packages/openhands-agent-server/docs/ARCHITECTURE.md#chatgpt-subscription-profiles).

## Procedure for a future isolated live test

1. Build and start the **SmolPaws product host** (`npm run relay-server:start`) from the reviewed checkout.
   It composes `packages/openhands-agent-server` with product tools; the bare package CLI intentionally
   has no scheduler/media executors. The bridge launcher checks `X-SmolPaws-Host: relay` and starts a
   supervised product host on loopback when absent. Verify the revision and explicit state paths.
2. Inspect the server's active LLM profile and credential availability without exposing values. Legacy
   `LLM_PROFILE_ID` does not select this profile. Do not silently choose another model. Run an internal
   real-provider tool call and continuation before opening the WhatsApp socket.
3. Stop/drain the legacy host. The already-running pre-change binary has no process lock; deploying
   the new lock does not retroactively stop that socket. Back up private ledger, router JSON, relay,
   scheduler and server state while stopped. The updated legacy host is the supported rollback target.
4. Use an explicit registered-chats file containing only the trusted control chat. Set
   `SMOLPAWS_WHATSAPP_REGISTERED_GROUPS`, `SMOLPAWS_WHATSAPP_ROUTER_STATE`, `SMOLPAWS_RELAY_DB_PATH`,
   `SMOLPAWS_SCHEDULER_DB_PATH` and server persistence/state. Startup notices are enabled by default
   for every registered chat; set `SMOLPAWS_WHATSAPP_STARTUP_PING=0` only for an intentionally silent
   test, then remove that override when normal testing begins.
   `SMOLPAWS_HOME_DIR` now relocates the default relay path as well as WhatsApp state. The native
   host uses its own relay database beside the scheduler; use `SMOLPAWS_AGENT_SERVER_RELAY_DB_PATH`
   only if it needs an explicit path. Never point two platform workers at one work database.
5. Account for scheduled work and queued voice files in that test window. A canary allowlist excludes
   other chats, but tasks for its allowed chat can still become due. Pause them if the test excludes
   scheduled sends. Keep the existing `groups/main` workspace and intended context.

A fresh relay filename alone cannot isolate an existing server conversation. Use separate server
persistence for an isolated canary or reconcile the original relay store; owner mismatch fails closed.

## Procedure for a controlled one-chat canary

Use a bounded, authorized live-send window. Trace a unique input through all six boundaries:

1. Inbound row in the WhatsApp ledger.
2. Durable intake reaches `done`.
3. Expected server conversation contains the user event and completed run.
4. Expected mid-turn/final delivery rows exist.
5. Delivery is `done`, with `send_attempted=1` and an external WhatsApp message ID.
6. One correctly prefixed reply appears in the intended chat.

Then test a scheduled reply, attachment and playable voice note, duplicate input, queued outbound
restart, and reconnection. Live Slack uploads additionally require `files:write`; Discord needs
attachment permission in the destination channel. Do not treat a text reply as media proof.

## Rollback and re-cutover

Start from the current production ledger, relay, scheduler, and conversation state. Do not point the
handoff at retired canary paths or restore a pre-promotion snapshot over newer progress. Drain the
active run and outbox, stop the standalone WhatsApp bridge, then run:

```bash
npm run whatsapp:handoff -- legacy
```

The command takes the same device lock, verifies no unsettled relay work or unprojected events,
checks conversations are idle/finished, refuses outstanding scheduled occurrences or partially imported voice batches, exports task
changes to the legacy table, and marks the ledger ready for the **updated** legacy host. It sends
nothing. Only then start that host. The shared server can keep serving other bridges.

At re-cutover, stop the legacy host again. Identity progress remains shared; task changes and deletions
made during rollback are imported. Do not delete the journal or replay old JSON into an initialized
ledger. Do not roll back to an older binary that ignores the journal.

`delivery_unknown` and parked interrupted tools require inspection of the actual outcome before an
operator explicitly reconciles them. Media spool files are retained for reconciliation; clean them
only after their delivery records no longer need replay or inspection. WhatsApp promotion does not
imply retirement of unrelated legacy ingress services; track their migration separately in Beads.
