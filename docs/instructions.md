# Hybrid GitHub mention intake (webhooks + notifications)

This repo supports two independent ways to trigger the agent when someone comments `@smolpaws ...`.

- **Webhook path (GitHub App)**: near-real-time for repos where the GitHub App is installed.
- **Notifications path (GitHub user token)**: works across *any* repo where the `smolpaws` user receives a GitHub notification for the mention.

Both paths converge into the same pipeline:

GitHub → Worker → Queue → Runner → GitHub comment reply

## 1) Webhook path (GitHub App)

### What you get
- Fast, event-driven triggers
- Installation-scoped permissions
- Only works for repos where the GitHub App is installed

### Required Worker secrets
Set these as Cloudflare Worker secrets (e.g. via `wrangler secret put ...`):

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`

### GitHub App configuration
- Subscribe to webhook events:
  - `issue_comment` (created)
  - `pull_request_review_comment` (created)
- Webhook URL: `https://<your-worker-domain>/webhooks/github`

## 2) Notifications path (GitHub user token)

### What you get
- Works for mentions in **any repo** where the `smolpaws` GitHub user can see the thread
- Does **not** require the GitHub App to be installed
- Polling-based (cron), not instant

### Required Worker secret
- `GITHUB_USER_TOKEN`

This should be a token for the **`smolpaws` GitHub user**.

Minimum permissions depend on where you want it to operate:
- To *read mentions*: needs access to **Notifications**.
- To *reply back*: needs permission to **create issue comments** in the target repos.
  - Public-only: typically `public_repo` (classic PAT) is sufficient.
  - Private repos: requires broader repo access.

### Cron trigger
The Worker is configured with a 1-minute cron schedule in `wrangler.toml`:

```toml
[triggers]
crons = ["*/1 * * * *"]
```

On each tick the Worker:
1. Calls `GET https://api.github.com/notifications?per_page=50`
2. Filters notifications where `reason == "mention"`
3. Fetches the latest comment (`subject.latest_comment_url`) and checks for `@smolpaws`
4. Enqueues a queue message for processing
5. Marks the notification thread as read

## 3) Allowlisting / spam control

The Worker can restrict which mentions are accepted via environment variables:

- `ALLOWED_ACTORS` — comma-separated GitHub usernames
- `ALLOWED_OWNERS` — comma-separated repo owners/orgs
- `ALLOWED_REPOS` — comma-separated full repo names (`owner/repo`)
- `ALLOWED_INSTALLATIONS` — comma-separated GitHub App installation IDs (only applies when an installation id is present)

Notes:
- For the notifications path there is **no** `installation.id`, so `ALLOWED_INSTALLATIONS` is ignored.
- If you enable notifications without allowlists, anyone can mention `@smolpaws` in public repos and trigger replies.

## 4) Runner integration

### Worker → Runner
If configured, the Worker will call the Runner URL:

- `SMOLPAWS_RUNNER_URL` (e.g. `https://runner.example.com/run`)
- Optional: `SMOLPAWS_RUNNER_TOKEN` (Bearer token)

The Worker sends the runner a request shaped like:

```json
{
  "event": "issue_comment" | "pull_request_review_comment",
  "payload": { "comment": { "body": "..." }, "repository": { "full_name": "..." }, "issue": { "number": 123 } },
  "delivery_id": "...",
  "github_token": "..."
}
```

### Runner required env
At minimum:

- `LLM_MODEL`
- `LLM_API_KEY`

Optional:
- `DAYTONA_API_KEY` (enables Daytona execution)

## 5) Operational notes

- The notifications path marks threads as read after enqueueing. If a queue job fails and retries, it will not be re-enqueued by polling (but the queued message will still retry).
- For private repos, the `smolpaws` user must have repo access or notifications won’t be delivered.
