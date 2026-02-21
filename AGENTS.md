# Repository Guidelines

## Overview
This repo implements **smolpaws**:
- A **Cloudflare Worker** that receives GitHub App webhooks, verifies signatures, filters/allowlists events, and enqueues work on **Cloudflare Queues**.
- A **Fastify runner** that executes an agent via `@smolpaws/agent-sdk` (optionally dispatching execution into **Daytona** sandboxes) and replies back to GitHub by posting a comment.

High-level flow: GitHub → Worker (`/webhooks/github`) → Queue → Runner (`/run`) → GitHub comment.

## Project Structure
- `src/index.ts`: Cloudflare Worker entrypoint (webhook + queue consumer).
- `src/shared/github.ts`: Shared types for webhook/queue/runner payloads.
- `src/runner.ts`: Fastify “agent-server” with `/run` and conversation APIs.
- `src/daytona.ts`: Optional Daytona execution helper.
- `docs/`: Ops/deployment notes.
- `.agents/skills/`: Reference skills for GitHub Apps/webhooks, Wrangler, Queues, Fastify, TypeBox, Daytona.

## Dev Commands
Prereqs: Node.js (18+ recommended).

```bash
npm install
npm run typecheck

# Worker
npm run worker:dev      # wrangler dev
npm run worker:deploy   # wrangler deploy

# Runner
LLM_MODEL=<model> LLM_API_KEY=<key> npm run runner:dev
npm run runner:start
```

## Coding & API Conventions
- TypeScript is **strict** (`tsconfig.json`). Prefer small, typed helpers over `any`.
- **ESM imports**: keep `type: "module"` behavior; use explicit `.js` import specifiers where required.
- Keep **Worker** code Cloudflare-compatible (Web Crypto, `fetch`, no Node-only APIs).
- Runner endpoints should remain **schema-first** (TypeBox schemas + `Static<typeof Schema>`).
- When expanding GitHub payload usage, update `src/shared/github.ts` with optional fields (GitHub payloads vary by event).

## Configuration & Secrets
- Never commit secrets. Use `wrangler secret put` for Worker secrets.
- Worker expects: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, allowlists (`ALLOWED_*`), and runner routing (`SMOLPAWS_RUNNER_URL`, `SMOLPAWS_RUNNER_TOKEN`).
- Runner commonly needs: `LLM_MODEL`, `LLM_API_KEY` (plus optional `DAYTONA_*`).

## Testing
No dedicated test suite yet. If you add tests, keep them lightweight and runnable in CI (prefer minimal Node-based tests) and cover both webhook verification and runner request handling.
