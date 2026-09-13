# Weekly re-vendor automation runbook

This runbook is the procedure an unattended coding agent follows to keep
`@smolpaws/openhands-agent-server` in lockstep with the SDK transpile
`enyst/openhands-agent` and with upstream `OpenHands/software-agent-sdk`.
It is written for a scheduled OpenHands Cloud automation with a hard
wall-clock budget, but a human can follow it verbatim.

It does not replace policy. Read these first, in this order:

1. [`../TRANSPILE_RULES.md`](../TRANSPILE_RULES.md) — scope, dispositions, `DEV-SERVER-*` / `EXT-SERVER-*` policies, tests-first and OpenAPI rules.
2. `enyst/openhands-agent/docs/DRIFT_TOOLING.md` (in the vendored SDK repo) — how intervals are generated and reviewed.
3. The SDK-side interval record for the interval you are about to vendor: `transpile/updates/<OLD8>..<NEW8>.md` and `.inventory.json` in `enyst/openhands-agent`. Its `:server` rows are your review list.

If anything here contradicts `TRANSPILE_RULES.md`, the rules win.

## Outcome of one run

Exactly one of:

- **SDK `main` pins the same upstream commit the vendored manifest pins** → nothing to vendor. Print a short summary and exit. Do not open a PR.
- **An open re-vendor PR already exists** (head branch `revendor/…`) → resume it.
- **SDK `main` moved to a newer pin** → one PR on branch `revendor/<OLD8>..<NEW8>` that re-vendors the SDK, reviews the server units of that interval, ports `PORT` items, regenerates the pinned Python OpenAPI, and passes package CI. If the budget runs out, a pushed branch and a draft PR with a `## Handoff` section.

Never merge. Never push to `main`. Never vendor an SDK commit that is not on the SDK's `main`.

## Time budget

The automation is killed at 30 minutes. Plan for 25.

| Checkpoint | Deadline | If late |
|---|---|---|
| Repos cloned, dependencies installed, interval known | 7 min | continue |
| SDK re-vendored, provenance check green, committed and pushed | 12 min | continue |
| Server review record written, `PORT` items done | 21 min | stop porting; push; draft PR with `## Handoff` |
| Python OpenAPI regenerated, policies reconciled, `npm run ci` green, PR opened | 27 min | push what is committed; draft PR with `## Handoff` |

Commit and push after every completed step. Only a pushed branch survives the sandbox.

## Environment setup

The automation clones `enyst/smolpaws` for you. Work inside that clone (`ROOT`).

```sh
node --version                       # 22.x expected
npm ci
npm ci --prefix packages/openhands-agent-server
command -v uv >/dev/null || python3 -m pip install --user uv

# SDK transpile at main (full history is not needed; one commit is)
git clone --depth 1 https://github.com/enyst/openhands-agent ../openhands-agent
SDK=../openhands-agent

# Upstream Python source, needed for the OpenAPI oracle and for reading diffs
git clone --filter=blob:none https://github.com/OpenHands/software-agent-sdk ../software-agent-sdk
UPSTREAM=../software-agent-sdk
```

Pins are always read from manifests, never typed by hand:

```sh
OLD_PIN="$(node -p "require('./packages/openhands-agent-server/vendor/openhands-agent/transpile/upstream.json').commit")"
NEW_PIN="$(node -p "require('$SDK/transpile/upstream.json').commit")"
SDK_COMMIT="$(git -C "$SDK" rev-parse HEAD)"
```

If `OLD_PIN == NEW_PIN`: stop, print `vendored SDK already at upstream <NEW_PIN>`, exit successfully.

If the SDK's `main` is **more than one interval ahead** (there are several
`transpile/updates/*.json` files in the SDK whose `from` is at or after
`OLD_PIN`), still vendor `main` in one go: the vendored package is the built
artifact of one SDK commit, it cannot be vendored piecewise. Review the server
units of **every** SDK interval between `OLD_PIN` and `NEW_PIN`.

Branch: `revendor/${OLD_PIN:0:8}..${NEW_PIN:0:8}`, created from `origin/main`.

## Resuming an open re-vendor PR

Before doing anything else, look for an open PR whose head branch starts with
`revendor/`. If one exists: check it out, read its `## Handoff`, fix red CI
first, then continue from the first unfinished step. Do not open a second
re-vendor PR while one is open. If a human is discussing it, exit with a summary.

## Procedure

### Step 1 — re-vendor the SDK

```sh
scripts/vendor-openhands-agent.sh "$SDK"
```

The script builds and `npm pack`s the SDK, replaces
`packages/openhands-agent-server/vendor/openhands-agent/{dist,transpile/upstream.json,package.json}`,
re-links the package dependency, and runs `npm run test:upstream-provenance`.
It refuses a dirty SDK checkout and records `_smolpawsProvenance.gitCommit`
= `SDK_COMMIT`. The SDK's own tests run as part of it; if they fail, the
SDK `main` is broken — stop and open an issue-style summary instead of a PR.

Commit:

```
re-vendor agent-server SDK <OLD8>..<NEW8> (vX.Y.Z -> vA.B.C)
```

Push immediately.

### Step 2 — write the server review record

The SDK repo already generated the facts. For each SDK interval file
`$SDK/transpile/updates/<from8>..<to8>.inventory.json` inside `OLD_PIN..NEW_PIN`,
list its units whose target is `server` (keys ending in `:server`) plus every
changed path under `openhands-agent-server/`, `tests/agent_server/`,
`tests/cross/`, and `examples/02_remote_agent_server/`.

Create `packages/openhands-agent-server/transpile/updates/<OLD8>..<NEW8>.md`
using this layout (the convention is defined in `TRANSPILE_RULES.md`, section
"Server review records"):

```markdown
# Server review: <OLD_PIN> .. <NEW_PIN>

SDK intervals covered: <list of SDK interval file names>
Vendored SDK commit: <SDK_COMMIT>

| Upstream commit | Subject | Disposition | Policy | Reason | Evidence |
|---|---|---|---|---|---|
| `<sha12>` | … | PORT | — | … | `src/__tests__/foo.test.ts` |
| `<sha12>` | … | NO_TARGET_CHANGE | — | version bump only | — |
| `<sha12>` | … | DEVIATION | DEV-SERVER-002 | confirmation gates are not active behavior | — |
| `<sha12>` | … | DEFERRED | OPENAPI-DEFERRED-001 | … ; revisit when … | — |

## OpenAPI delta
<summary of operations added/removed/changed between the two pinned Python OpenAPI files, and which policy entries changed>
```

Classify before coding. Read each upstream commit's server diff
(`git -C "$UPSTREAM" show <sha> -- openhands-agent-server tests/agent_server tests/cross`).
Map to `src/*.ts` by router/service name (`event_router.py` → `src/eventRouter.ts`,
`conversation_service.py` → `src/conversationService.ts`, `pub_sub.py` → `src/pubSub.ts`,
`sockets.py` → `src/sockets.ts`, `models.py` → `src/models.ts`, and so on).

Disposition guide (server flavor):

| Situation | Disposition |
|---|---|
| Route/request/response/WebSocket behavior changed and the TS server implements that route | `PORT` |
| Version bumps, `uv.lock`, CI scripts, Python-only packaging, tests of Python-only helpers | `NO_TARGET_CHANGE` with a specific reason |
| ACP, security analyzer/confirmation, cipher/plaintext secrets, raw-LLM settings, deferred-init | `DEVIATION` with `DEV-SERVER-00x` |
| A route the TS server does not implement yet | `DEFERRED` referencing `OPENAPI-DEFERRED-001`; make sure `transpile/openapi-policy.json` lists the operation |
| Whole subsystem outside scope (plugin/marketplace runtime) | `EXCLUDED` with `EXC-SDK-00x` |

Commit the record: `drift(server <OLD8>..<NEW8>): classify server review units`. Push.

### Step 3 — port `PORT` items tests-first

For each `PORT`, smallest first:

1. Find or write the upstream-equivalent test under `src/__tests__/` (real
   Fastify app via `createAgentServerApp`, real temp dirs; see existing tests).
2. Run it alone and confirm red: `npx vitest run src/__tests__/<file>.test.ts`.
3. Implement the smallest change. Keep queue/delivery semantics out of the
   server; keep raw secrets out of metadata/events/logs.
4. If the change alters a route, regenerate the TS OpenAPI: `npm run openapi`
   (commits `openapi.json`).
5. Fill the `Evidence` column in the review record.
6. Commit `port(server <sha8>): <what> (PORT)`. Push.

If a `PORT` exceeds the remaining budget, reclassify it `DEFERRED` with a
revisit note, mention it in the PR, and leave no half-implemented code.

### Step 4 — regenerate the pinned Python OpenAPI and reconcile policies

```sh
git -C "$UPSTREAM" checkout --detach "$NEW_PIN"
packages/openhands-agent-server/scripts/refresh-python-openapi.sh "$UPSTREAM"
```

This runs `uv sync --locked --dev` inside the upstream checkout (Python 3.12+
is fetched by `uv` automatically; budget 2–5 minutes), generates the schema,
and canonicalizes it into `transpile/python-openapi.json` + `.meta.json`.

Then, inside `packages/openhands-agent-server`:

```sh
npm run openapi
npm run test:openapi-parity
```

The comparator reports four lists. Fix each until it passes:

- `unclassifiedMissing` — upstream added an operation the TS server lacks: either `PORT` it now or add it to `missingOperations` in `transpile/openapi-policy.json` as `DEFERRED` / `OPENAPI-DEFERRED-001` with a reason (and record it in the review file).
- `staleMissingPolicies` — upstream removed an operation we listed as missing: delete that policy entry.
- `unclassifiedExtensions` — the TS server exposes an operation upstream does not: it needs an `EXT-SERVER-*` entry in `extensions`; if there is no such policy, you added a route that must not exist — remove it.
- `staleExtensionPolicies` — an extension entry no longer matches a served route: delete it.

Contract mismatches on shared operations (parameters, request media types,
status codes) are `PORT` work, or an explicit `contractExemptions` entry only
when a `DEV-SERVER-*` policy justifies it.

Commit: `chore(agent-server): regenerate pinned Python OpenAPI at <NEW8>` (and
a separate `reconcile OpenAPI parity policies for <NEW8> oracle` if the policy
file changed). Push.

### Step 5 — evidence

```sh
npm run ci --prefix packages/openhands-agent-server
npm run build --prefix packages/openhands-agent-server
npm run typecheck                       # repo root
npm run coordinator:test                # Message Relay against the real server
npm ci --prefix apps/slack && npm run typecheck --prefix apps/slack && npm run test --prefix apps/slack
```

All must be green. `npm run ci` in the package already covers provenance,
OpenAPI parity, unit tests, local smoke, coverage, typecheck, lint, build, and
the packed-consumer smoke.

### Step 6 — open the PR

Title: `Re-vendor agent-server SDK <OLD8>..<NEW8> (vX.Y.Z -> vA.B.C) + server ports`.

Body must contain:

- the interval and SDK commit vendored;
- the disposition counts from the review record and every `DEFERRED` with its reason;
- the OpenAPI delta summary and any policy entries added/removed;
- the evidence commands run;
- a `## Handoff` section only if the branch is partial (open as draft then).

Base branch `main`.

## Hard rules

- The vendored `dist/` is generated by `scripts/vendor-openhands-agent.sh` only. Never hand-edit files under `vendor/`.
- `vendor/openhands-agent/transpile/upstream.json` is the only pin. Do not copy the SHA into prose, scripts, or policy JSON.
- Do not add queue, retry, ordering, or delivery-state behavior to the server. That lives in `src/coordinator/` (Message Relay) and is out of scope for this automation.
- Never disable, skip, or loosen a test to get green.
- Do not edit `TRANSPILE_RULES.md`, `docs/ARCHITECTURE.md`, or `src/coordinator/DESIGN.md` in a re-vendor PR; describe needed doc changes in the PR instead.
- No secrets anywhere in commits, records, or PR text.
- Commit messages: no model names; `Co-authored-by: openhands <openhands@all-hands.dev>` is fine.
