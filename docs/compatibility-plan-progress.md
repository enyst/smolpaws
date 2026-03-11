# Paw-print Eval: TypeScript runtime compatibility plan progress

This document tracks progress against the cross-repo convergence plan originally captured in `/workspace/project/.agents_tmp/PLAN.md` and mirrored to [enyst/OpenHands-Tab#996](https://github.com/enyst/OpenHands-Tab/issues/996).

## Goal

Converge the TypeScript agent stack so these three codepaths can share one coherent runtime story without forcing an early repository merge:

- `smolpaws` — WhatsApp ingress + container-side agent runner
- `enyst-smolpaws` — GitHub ingress + Fastify runner + optional Daytona
- `OpenHands-Tab/packages/agent-sdk` — canonical TypeScript SDK/runtime source

## Working assumptions

- Treat `OpenHands-Tab/packages/agent-sdk` as the canonical TypeScript SDK source unless we deliberately move it.
- Keep Cloudflare as the GitHub ingress and queue layer for now.
- Converge on one shared remote runtime contract before making repo-layout decisions.
- Preserve the SDK's current optional VS Code integration until it becomes a real blocker.

## Progress snapshot

### Done

- **Plan recorded on GitHub**
  - `enyst/OpenHands-Tab#996` stores the current convergence plan.
- **SDK version drift reduced**
  - `smolpaws/container/agent-runner` was bumped from `@smolpaws/agent-sdk ^0.8.0` to `^0.9.0`.
  - This landed via `smolpaws/smolpaws#2`.
- **Initial remote workspace compatibility routes added to `enyst-smolpaws`**
  - `GET /api/health`
  - `GET /api/file/download/*`
  - `POST /api/file/upload/*`
  - `POST /api/bash/start_bash_command`
  - `GET /api/bash/bash_events/search`
  - `GET /sockets/events/:conversationId`
  - persistence-backed `GET /api/conversations`, `GET /api/conversations/:conversationId`, `GET /api/conversations/:conversationId/events/search`, and `GET /api/conversations/:conversationId/events/download`
  - initial `GET /api/git/changes` and `GET /api/git/diff` query endpoints
- **Initial auth compatibility added**
  - compatibility routes accept `X-Session-API-Key` as well as Bearer auth.
- **Workspace boundary hardening added**
  - compatibility routes are restricted to the configured workspace root.
  - file and bash checks resolve real filesystem paths so symlink escapes are blocked.
  - `POST /api/conversations` now rejects `workspace.working_dir` outside the configured root.

### In progress

- **Remote agent-server contract parity in `enyst-smolpaws`**
  - The open work is being tracked in the next PR after `enyst/smolpaws#4`.
  - The runner now covers a meaningful subset of the TypeScript `RemoteWorkspace` contract and now has an initial websocket event stream for `RemoteConversation`, but it is still incomplete.
- **Canonical ownership / boundary documentation**
  - We are working with the assumption that OpenHands-Tab owns the SDK source, but this still needs to be made explicit enough that future changes do not drift again.

### Not started yet

- **Conversation contract parity review** against the Python OpenHands agent-server
- **Browser strategy convergence** (`browser_use` replacement / `agent-browser` standardization)
- **Ingress convergence** between WhatsApp and GitHub around one shared execution surface
- **Repository consolidation decision** after the interfaces stabilize
- **Daytona-specific cleanup** = optional, and after the shared gateway contract is stable

## Plan checklist

### 1. Canonical ownership model
- [ ] Make the ownership model explicit in repo docs and package release flow.
- [x] Use `OpenHands-Tab/packages/agent-sdk` as the working canonical source.

### 2. SDK boundary / host strategy
- [x] Treat full VS Code extraction as follow-up work, not a prerequisite.
- [ ] Audit and document the remaining VS Code-coupled touchpoints in one place.

### 3. SDK version alignment
- [x] Upgrade `smolpaws/container/agent-runner` to the 0.9.x SDK line.
- [ ] Decide the long-term distribution path: published package vs shared source vs git dependency.

### 4. Browser strategy
- [ ] Replace placeholder `browser_use` behavior with one real browser path.
- [ ] Decide whether `agent-browser` is the shared implementation.

### 5. Remote agent-server contract
- [~] `/api/conversations` lifecycle parity review
- [x] `/sockets/events/:conversationId`
- [x] `/api/file/download/*`
- [x] `/api/file/upload/*`
- [x] `/api/bash/start_bash_command`
- [x] `/api/bash/bash_events/search`
- [~] initial `/api/git/changes` + `/api/git/diff` query parity
- [~] auth semantics aligned enough for initial `X-Session-API-Key` / Bearer compatibility

### 6. Ingress convergence
- [ ] Define one shared execution service abstraction used by both ingress layers.

### 7. Repository consolidation decision
- [ ] Revisit only after the runtime contract and ownership model are stable.

### 8. Delivery order
- [~] We have started with version alignment and remote compatibility work before broader cleanup.

## Current PRs / issues

- **Plan issue**: [enyst/OpenHands-Tab#996](https://github.com/enyst/OpenHands-Tab/issues/996)
- **Merged SDK alignment PR**: [smolpaws/smolpaws#2](https://github.com/smolpaws/smolpaws/pull/2)
- **Current compatibility PR**: [enyst/smolpaws#4](https://github.com/enyst/smolpaws/pull/4)

## Validation used so far

- `smolpaws/container/agent-runner`: `npm run build`
- `enyst-smolpaws`: `npm run typecheck`
- manual `curl` validation for:
  - `/api/health`
  - file upload/download routes
  - `X-Session-API-Key` auth on compatibility routes
  - bash command start + bash event search
  - symlink escape blocking
  - rejecting out-of-root `workspace.working_dir`
- websocket route validation via live runner logs while creating a conversation, opening `/sockets/events/:conversationId`, and sending follow-up conversation events

## Next recommended slice

The next meaningful slice is **conversation parity cleanup**: validate the websocket stream directly against `RemoteConversation`, decide whether more of the Python conversation semantics need to be mirrored, and then fill the next contract gaps instead of adding more ad-hoc runner behavior.
