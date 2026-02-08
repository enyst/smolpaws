# Smolpaws Ops Notes

## Architecture (current)

1. **GitHub App** receives `issue_comment` + `pull_request_review_comment` webhooks.
2. **Cloudflare Worker** validates signature + allowlists, then enqueues a job on **Cloudflare Queues**.
3. **Queue consumer** (same Worker) posts to the Fastify runner `/run` endpoint.
4. **Fastify runner** uses `@smolpaws/agent-sdk` to run an agent and returns a reply.

```
GitHub → CF Worker (webhook/auth) → CF Queue → Fastify Runner → GitHub comment
```

## Cloudflare setup

### 1) Create the queue

```bash
npx wrangler queues create smolpaws-queue
```

### 2) Worker bindings

Already configured in `wrangler.toml`:

```toml
[[queues.producers]]
queue = "smolpaws-queue"
binding = "SMOLPAWS_QUEUE"

[[queues.consumers]]
queue = "smolpaws-queue"
max_batch_size = 1
max_batch_timeout = 5
```

### 3) Worker secrets

Set in Cloudflare dashboard or via `wrangler secret put`:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `ALLOWED_ACTORS` (ex: `enyst`)
- `ALLOWED_OWNERS` (ex: `enyst`)
- `ALLOWED_REPOS` (optional, ex: `enyst/smolpaws`)
- `ALLOWED_INSTALLATIONS` (optional)
- `SMOLPAWS_RUNNER_URL` (Fastify runner URL)
- `SMOLPAWS_RUNNER_TOKEN` (Bearer token expected by runner)

### 4) Deploy Worker

```bash
npm install
npm run worker:deploy
```

## GitHub App setup

1. Create a GitHub App named `smolpaws`.
2. Permissions:
   - Issues: Read/Write
   - Pull Requests: Read/Write
   - Contents: Read
3. Events:
   - `issue_comment`
   - `pull_request_review_comment`
4. Webhook URL: `https://<worker-host>/webhooks/github`
5. Add the webhook secret to `GITHUB_WEBHOOK_SECRET` in Cloudflare.
6. Install the app on the allowed repos.

## Fastify runner (agent-server)

### Run locally

```bash
npm install
LLM_MODEL=<model> LLM_API_KEY=<key> npm run runner:dev
```

### Required env vars

- `LLM_MODEL` (required)
- `LLM_API_KEY` (required for hosted LLMs)
- `LLM_BASE_URL` (optional)
- `LLM_PROVIDER` (optional)
- `SMOLPAWS_RUNNER_TOKEN` (optional bearer auth)
- `SMOLPAWS_WORKSPACE_ROOT` (optional workspace path)
- `SMOLPAWS_PERSISTENCE_DIR` (optional persistence root; defaults to `~/.openhands/conversations`)
- `OPENHANDS_CONVERSATIONS_DIR` (optional alias for persistence root)

## Cloudflare Containers note

Cloudflare Containers requires the **Workers Paid** plan. The Containers pricing page currently lists **no free tier** for Containers; usage is included under Workers Paid with additional usage billed separately.


## Daytona integration draft

Target: keep **Worker + Queue** as the public entrypoint, then dispatch agent runs into **Daytona sandboxes**.

**Proposed flow**
1. Runner receives `/run` or `/api/conversations`.
2. If Daytona is enabled (ex: `DAYTONA_API_KEY` present), create/reuse a sandbox via `@daytonaio/sdk`.
3. Bootstrap the sandbox:
   - `git clone` the repo (using a GitHub installation token)
   - `npm install` (or cached deps)
   - set `SMOLPAWS_WORKSPACE_ROOT` to the cloned repo
4. Execute an agent entry script inside the sandbox (ex: `node scripts/daytona-run.ts --prompt "..."`).
5. Capture stdout (or stream via process sessions) and return the reply to the runner.
6. Stop or delete the sandbox (or keep warm per repo).

**Suggested env vars**
- `DAYTONA_API_KEY` (required)
- `DAYTONA_API_URL` (optional)
- `DAYTONA_TARGET` (optional)
- `SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES` (optional)
- `SMOLPAWS_DAYTONA_REUSE_SANDBOXES` (optional)

**Implementation notes**
- Add a small runner-side adapter (ex: `src/daytona.ts`) to manage sandbox lifecycle.
- Use Daytona process sessions for streaming logs when we add websocket support.
- Persistence can stay on the runner host (`SMOLPAWS_PERSISTENCE_DIR`) while sandbox runs are ephemeral.

## Remaining work

- Implement repo checkout for GitHub events (clone + working dir setup).
- Add websocket streaming endpoints for events.
- Implement `/api/bash`, `/api/file`, `/api/git` for full remote workspace compatibility.
- Implement Daytona runner dispatch (sandbox lifecycle + agent entry script).
- Confirm Fastify runner deployment target (Cloudflare Containers vs other host).
