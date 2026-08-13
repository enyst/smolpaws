# Message Work Coordinator — Design & Implementation Plan

> Status: **in progress** · Owner: coordinator work (agent "TopazMoose") · Grounded in the ADR
> [*Durable message work belongs around agent-server*](https://enyst.github.io/arch/smolpaws-message-work-adr.html)
> (local: `~/repos/enyst.github.io/arch/smolpaws-message-work-adr.html`).

This document is the code-grounded plan for the durable coordinator that closes the loop between
the channel bridges, the SmolPaws agent-server, and the SDK. **Read the ADR first**; this doc only
records the concrete schema, interfaces, state machines, decisions, and the gaps I had to resolve.

---

## 0. Starting reality (what already exists)

The monorepo contains **two** agent-servers — and the coordinator integrates with the **new** one:

| Path | What it is |
| --- | --- |
| `packages/openhands-agent-server/` (`@smolpaws/openhands-agent-server`) | **The integration target.** The new, upstream-shaped TypeScript **transpile** of the Python SDK agent-server. A **library**, not a standing server: it runs an in-process Fastify app via `createAgentServerApp` (`src/app.ts`; see `examples/local-endpoint-smoke.ts`, `npm run smoke:local`). Its `openapi.json` is the **authoritative REST contract** (`/api/conversations`, `/events`, `/run`, `/pause`, `/interrupt`, `/events/search`, `/agent_final_response`, `/sockets/events`). Its README lists *"the future message-queue layer that replaces SmolPaws turns"* as required next work and *intentionally not wanted in this package* — i.e. **this coordinator lives outside it**, exactly per the ADR. Auth: `X-Session-API-Key`. Ground truth for semantics: the Python `~/repos/agent-sdk/openhands-agent-server/` (on :8000/:18000). |
| `apps/agent-server/` (runner, **:8788**) | The **older** SmolPaws runner on `@smolpaws/agent-sdk`. Reference only — it is what the coordinator + new server **replace**. It grew a home-grown turn queue whose gaps motivate this work. |

> The integration contract was validated against `packages/openhands-agent-server`'s `openapi.json`, `src/`,
> and `examples/local-endpoint-smoke.ts` (the real Fastify surface). The `/turns` material below is from the
> **old** runner and is retained only to enumerate the gaps the coordinator must close.

The old runner's turn queue (`apps/agent-server/src/runner/{turnState,outbox,outboundMessaging,taskCommands}.ts`
+ the `/turns*` routes in `agent-server/conversationRouter.ts`) is a first-generation version of what this
coordinator must own:

- **Intake**: `POST /turns` dedups on `idempotency_key` (`turnState.findMessageByIdempotencyKey`), appends
  the user message, starts execution. Persisted to `turns.json`.
- **Delivery**: agent calls a `send_message` (`current_thread_message`) tool → an entry is appended to
  `outbox.jsonl`; a bridge claims it via `/turns/:id/outbound_messages/claim` (**delete-on-claim**, atomic
  file rewrite, in-memory lock). Same shape for `task-commands.jsonl`.
- **Delivery owner**: first `delivery_owner_id` per turn wins (`turnState.assignDeliveryOwner`); only that
  owner may claim that turn's artifacts.

**Gaps in the existing runner queue** (exactly what the ADR says the coordinator must add):

- ❌ No `attempts`, no `available_at`/backoff, no claim-expiry/lease/generation fence.
- ❌ No retry: a failed send is simply lost or re-sent by the bridge with no durable record.
- ❌ No `delivery_unknown`: an ambiguous send is not represented — it is either dropped or blindly re-sent.
- ❌ On restart, an active turn is force-marked `stuck` (`conversationRuntime.loadTurnStateIfNeeded`); it is
  not resumed.
- ❌ No persisted **lane directory** (platform chat/thread → conversation): that mapping lives in the
  bridges (`src/index.ts` `sessions.json`, `buildConversationId(...)` per app), so it cannot be queried or
  reconciled centrally.
- ❌ File-per-conversation JSON/JSONL, not a single queryable durable store; no cross-lane audit.

> **This coordinator is therefore a refactor target, not a greenfield add.** Per the ADR's implementation
> order it is built **alongside** the runner (shadow path) and the `/turns` layer is removed only after a
> soak period (ADR §9 step 7). Nothing here rips out `/turns` yet.

---

## 1. Scope & placement

- **Location**: `src/coordinator/` in the SmolPaws host process. `better-sqlite3` + `zod` are already host
  deps; it builds with the existing `tsc` and tests with `tsx --test` (node:test), matching repo
  conventions. The ADR: *"it can run in the SmolPaws host process initially."* Not a workspace package
  (the repo is not an npm workspace).
- **Boundary**: the coordinator owns the durable SQLite store and the accept/claim/settle/reconcile/project
  mechanics. It talks to agent-server through a small injected `AgentServerClient` interface so the store is
  fully testable without a live server. Channel adapters compute the canonical `lane_key` (they already do:
  `src/whatsapp-jid.ts`, `src/scope.ts`) and perform the actual platform send; they do **not** own durable
  scheduling.

---

## 2. Ownership (from ADR §2 — one fact, one owner)

- agent-server EventLog: conversation events, execution state. **Source of truth for conversations.**
- Coordinator: external dedup, lane↔conversation directory, per-lane order, claims/retries/backoff,
  delivery outcome, audit. **Source of truth for external work.**
- Channel adapter: canonical `lane_key`, platform formatting, the actual send, optional reconciliation.

The coordinator never copies agent-server's execution state machine; it observes it.

---

## 3. Schema (SQLite)

Two tables. All timestamps are ISO-8601 UTC (`toISOString()`, `...Z`) stored as `TEXT` — lexicographically
ordered, so `available_at <= :now` string comparison is valid and needs no numeric column.

### `lanes` — the persisted lane directory (ADR §4)

```
lane_key         TEXT PRIMARY KEY   -- adapter-computed canonical key
conversation_id  TEXT NOT NULL      -- agent-server conversation this lane maps to
platform         TEXT NOT NULL
account_id       TEXT
chat_id          TEXT NOT NULL
thread_id        TEXT
display_name     TEXT
conversation_ready INTEGER NOT NULL DEFAULT 0  -- has agent-server confirmed the conversation exists?
created_at       TEXT NOT NULL
last_seen_at     TEXT NOT NULL
```

`conversation_ready` implements the crash-matrix row *"crash after lane mapping, before conversation
creation"*: the binding + reserved `conversation_id` are durable first; the conversation is ensured to exist
in agent-server before intake is accepted, and only then is the flag set.

### `work` — unified intake + delivery queue (ADR §4 canonical record)

```
id                  TEXT PRIMARY KEY
kind                TEXT NOT NULL        -- 'intake' | 'delivery'
source_key          TEXT NOT NULL        -- stable dedup identity (see §5)
lane_key            TEXT NOT NULL
sequence            INTEGER NOT NULL     -- monotonic per (lane_key, kind)
conversation_id     TEXT
agent_event_id      TEXT                 -- intake: deterministic id to append; delivery: originating event id
state               TEXT NOT NULL        -- ready|claimed|done|retry_wait|failed|delivery_unknown
available_at        TEXT NOT NULL        -- earliest claimable time (backoff schedule)
claim_owner         TEXT
claim_until         TEXT
generation          INTEGER NOT NULL DEFAULT 0   -- fence token; bumped on claim and on reconcile-to-ready
attempts            INTEGER NOT NULL DEFAULT 0
send_attempted      INTEGER NOT NULL DEFAULT 0    -- delivery: worker set this durably *before* the network send
last_error          TEXT
external_message_id TEXT                 -- delivery: platform ack
payload_json        TEXT NOT NULL        -- normalized input / immutable delivery intent (no creds, no live objects)
created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL

UNIQUE(kind, source_key)                 -- idempotent accept: duplicate returns the existing row
UNIQUE(lane_key, kind, sequence)         -- monotonic order per lane/kind
```

Indexes: `(state, available_at)` for claim scans; `(lane_key, kind, sequence)` for lane-head selection;
`(kind, source_key)` unique for dedup.

---

## 4. State machines (ADR §4, Fig 2)

**Intake**: `ready → claimed → done`; `claimed → retry_wait` (retryable) → (`available_at`) → `ready`;
exhausted → `failed`. Claim expiry: `claimed` past `claim_until` → `ready` (fenced).
*Done* = the deterministic user event exists in agent-server and execution was requested.

**Delivery**: `ready → claimed → done` (ack); `claimed → retry_wait → ready` (clean retryable failure,
**before any send**); `claimed → delivery_unknown` (ambiguous external effect — **never auto-retries**,
blocks the lane); exhausted → `failed`.

### Gap I resolved: distinguishing "died before send" from "died after send"

The ADR crash matrix says a delivery worker that *"dies before send"* should have its claim expire and
retry (safe, no external effect), but a send whose *"response was lost"* must become `delivery_unknown`
(never blind-retry). A bare claim-expiry cannot tell these apart if the worker died between the network
send and calling `settle`. **Resolution**: the delivery worker durably sets `send_attempted = 1` (a cheap
compare-and-set) *immediately before* invoking the platform. `reconcile` then treats an expired delivery
claim as:

- `send_attempted = 0` → return to `ready` (safe retry — matches *"no external effect yet"*).
- `send_attempted = 1` → move to `delivery_unknown` (a send may have happened; require reconciliation or an
  operator decision — matches *"exactly-once is impossible without platform support"*).

This is an honest implementation of the two crash-matrix rows and is documented here because the ADR's
canonical record did not name a `send_attempted` field.

---

## 5. Identity & ordering

- **`source_key`** (unique per kind):
  - intake: `{platform}:{account}:{stable_platform_message_id}` — the adapter's stable input identity.
  - delivery: `{agent_event_id}:{destination_lane_key}` — the ADR's event/destination uniqueness key,
    which makes projector replay idempotent.
- **`agent_event_id`** for intake is deterministic: `uuidv5(platform + source_message_id)` so a lost
  append response is safe to retry (requires the agent-server idempotent-append delta, ADR §8).
- **Ordering**: `sequence` is monotonic per `(lane_key, kind)`. Only the **lane head** — the smallest
  `sequence` among rows not in a terminal-resolved state (`done`/`failed`) — is claimable, and only if it is
  itself `ready` and `available_at <= now`. So `delivery_unknown`, `claimed`, `retry_wait`, and an earlier
  `ready` all block later work in the same lane/kind (no silent overtaking).

## 6. Coordinator interface (ADR §4)

```ts
adapter.computeLane(input)         // adapter-side, not the coordinator
resolveLane(lane)                  → LaneBinding            // find-or-create lane→conversation; reserve id
acceptIntake(binding, input)       → WorkRow                // existing-or-new intake work
projectDeliveries(conversationId)  → number                // events → delivery rows (idempotent)
claimReady(worker, now, kind?)     → ClaimedWork | null     // fenced lane-head claim
settle(claim, outcome)             → new state              // done|retry_wait|delivery_unknown|failed
reconcile(now)                     → ReconcileReport        // expire claims; heal
markSending(claim)                 → void                   // delivery: durable send_attempted before network
```

`AgentServerClient` (injected, faked in tests): `ensureConversation`, `appendEvent(convId, {event_id, role,
content, run})`, `searchEvents(convId, pageId, limit)`.

---

## 7. Implementation order (mirrors ADR §9)

1. ✅ **DONE — Specify the store + interface through tests.** Real SQLite, injected clock, no live server.
   Modules: `schema.ts`, `types.ts`, `store.ts`, `ids.ts`, `coordinator.ts`, `httpAgentServerClient.ts`,
   `idempotentAppend.ts`. Tests: `store.test.ts`, `coordinator.test.ts`, `httpAgentServerClient.test.ts`,
   `idempotentAppend.test.ts` — **35 passing**, strict `tsc --noEmit` clean. Covers concurrent lane
   resolution, persisted lane lookup, duplicate accept, per-lane head-of-line order, fenced claim /
   compare-and-set, claim expiry, exponential backoff → failed, `delivery_unknown` vs safe retry,
   operator skip/requeue/confirm, projector replay + pagination + cursor, and the append-response-loss
   window (deterministic event id → idempotent re-append).
2. ✅ **DONE — Idempotent event append on `packages/openhands-agent-server` (`event_id`), shipped and wired
   end-to-end (ADR §8).** Delivered in **PR #140**, squash-merged to `main` as **`f6b1b275b`** (branch
   deleted): `POST /events` accepts an optional caller-supplied `event_id` (uuid), persists the event
   **once** under that id (durable across restart via `syncFromDisk`; idempotent under concurrent same-id
   appends via a `DuplicateEventError` catch), and returns `{success, event_id, created}` — `created:false`
   on a replay. Additive and upstream-compatible: omit `event_id` and behavior is unchanged; no
   queue/ordering/delivery state enters the package (`TRANSPILE_RULES.md` respected). The coordinator's
   `integrateNextIntake` sends the deterministic `event_id` and reads `created` (`coordinator.ts`,
   `httpAgentServerClient.ts`), so a lost append response is safe end-to-end: the queue's claim fence
   re-appends the SAME id and the server replies `created:false` — **no duplicate user turn**. Proven by
   in-process `createAgentServerApp` + `TestLLM` integration tests (append → lost response / restart /
   concurrent → `created:false`, no duplicate). **The append-response-loss window is now closed end-to-end.**

   > The client-side **marker reconcile** (`idempotentAppend.ts` + `hasUserMessageWithMarker`) was
   > **dropped** in favor of `event_id` — see Decision D3. It is now dead code (unreferenced by any
   > production path) pending removal; the design is preserved in git history if the fallback is ever needed.
3. Intake-only shadow path on one non-critical channel; delivery unchanged.
4. Event projection + delivery work (already implemented behind the projector interface) wired to a
   recording adapter; prove projector crash cases before real sends.
5. Canary WhatsApp (media, aliases, restart) with a rollback switch.
6. Migrate Discord, Slack, GitHub, email onto the same interface.
7. Remove the old `apps/agent-server` `/turns` runner after a clean soak, once SmolPaws runs on the new
   `packages/openhands-agent-server` + this coordinator.

## 8. Decisions flagged for Engel (proceeding meanwhile; all behind interfaces)

- **D1 — Outbound projection source.** Production is *tool-driven* (`send_message` → outbox), which is
  strictly more expressive than "final response only". Decision: project delivery work from durable
  **`send_message` action events** in the EventLog (destination = the conversation's bound lane), with the
  terminal `finish`/assistant response as a fallback projection — unifying the ADR's projector interface
  with today's behavior. Reversible behind the projector.
- **D2 — Location `src/coordinator/`** in the host process (vs a new package). Chosen for convention fit;
  can be promoted to a package later.
- **D3 — Idempotency mechanism: server-side `event_id` is the SOLE mechanism; the marker reconcile was
  DROPPED.** Engel's call (reversing an earlier lean toward the marker): a caller-supplied `event_id` on
  `POST /events` is a **compatible, additive** extension of the agent-server protocol, not a harmful
  divergence — so we adopted it as the ADR §8 delta (shipped in PR #140, `f6b1b275b`). It is atomic at the
  server, needs no content marker, and keeps the intake path a plain `append(event_id) → {created}`. The
  marker approach (embed `oh-idem:…` in the user message, search `body=` before re-appending) is
  **dropped**, not kept as a fallback: it cost a visible comment in every user turn, and a search-then-append
  that was only race-safe by the coordinator's claim fence — both moot now that the server is atomically
  idempotent. `idempotentAppend.ts` + `hasUserMessageWithMarker` are now dead code slated for removal
  (design preserved in git history should a pre-`event_id` server ever need it).

None of these block Phase 1.
