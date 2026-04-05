# GitHub Ingress

Cloudflare Worker app for GitHub webhook and notification ingress.

## Quick Context

This app validates GitHub events, queues work, forwards prompts to the shared SmolPaws runner surface, and posts replies back to the active issue or pull request thread.

There are two practical ways to test it:

1. Local worker mode
   - Run `npm run github:dev`
   - This now goes through `scripts/run-local-github-worker.sh`
   - That launcher loads `~/.smolpaws/.env`, writes a temporary `apps/github/.dev.vars.smolpaws`, and starts `wrangler dev --env smolpaws`
   - Local mode does **not** pull deployed Cloudflare secrets automatically; `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY` must exist locally if you want webhook handling on `localhost:8787`

2. Deployed worker + local runner mode
   - Leave the webhook URL pointed at the deployed Cloudflare worker
   - Run the local agent-server with `npm run runner:local`
   - Expose it temporarily with `cloudflared tunnel --url http://localhost:8788`
   - Point the deployed Worker secret `SMOLPAWS_RUNNER_URL` at the resulting public tunnel URL
   - This is the simplest real end-to-end GitHub test path on this machine

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entrypoint, queue consumer, GitHub API helpers |
| `src/agentServerClient.ts` | Worker-to-agent-server turn client |
| `wrangler.toml` | Cloudflare Worker/Queues configuration |
| `../../src/shared/runner.ts` | Shared runner protocol types |
| `../../src/shared/turnClient.ts` | Shared turn API client used by GitHub/Discord/local runtime |
| `../../scripts/run-local-github-worker.sh` | Canonical local launcher that loads `~/.smolpaws/.env` |

## Development

```bash
npm run github:dev       # Local worker with wrangler dev
npm run typecheck        # Type-check the whole repo
npm run github:test      # Run GitHub ingress tests
```

## Deployment

Deploy the Worker to Cloudflare after merging to main:

```bash
npm run github:deploy    # wrangler deploy from apps/github
```

Verify the deployment:

```bash
curl https://smolpaws.liberty-labs.org/health   # should return "ok"
```

### Secrets

Worker secrets are managed with `wrangler secret` (run from `apps/github/`):

```bash
npx wrangler secret list                        # list configured secrets
npx wrangler secret put SMOLPAWS_RUNNER_URL     # set/update a secret (prompts for value)
```

Required secrets: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `SMOLPAWS_RUNNER_URL`, `SMOLPAWS_RUNNER_TOKEN`. Optional: `GITHUB_USER_TOKEN` (for notification polling).

### Deployed URL

- Production: `https://smolpaws.liberty-labs.org`
- Webhook endpoint: `POST https://smolpaws.liberty-labs.org/webhooks/github`
- Notification polling runs on a cron schedule (`* * * * *`)

## Local Notes

- Canonical local worker URL: `http://127.0.0.1:8787`
- Canonical local agent-server URL: `http://127.0.0.1:8788`
- The Worker `SMOLPAWS_RUNNER_URL` must be the agent-server base URL and must not end with `/run`
- Remote `wrangler dev --remote` is not the preferred GitHub test path here because Queue behavior is not reliable enough for the real ingress flow
