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

## Cloudflare Containers note

Cloudflare Containers requires the **Workers Paid** plan. The Containers pricing page currently lists **no free tier** for Containers; usage is included under Workers Paid with additional usage billed separately.

## Remaining work

- Implement repo checkout for GitHub events (clone + working dir setup).
- Add websocket streaming endpoints for events.
- Implement `/api/bash`, `/api/file`, `/api/git` for full remote workspace compatibility.
- Add persistence for conversations (optional).
- Confirm Fastify runner deployment target (Cloudflare Containers vs other host).
