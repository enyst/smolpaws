# Slack App

Planned local Slack ingress app for SmolPaws.

## Status

This app directory is reserved for the upcoming Slack implementation. The production Slack path is **not built yet**. Current Slack access still goes through the Chrome workaround described in `docs/smolpaws/MEMORY.md`.

## Quick Context

The goal is to replace browser automation with a real Slack app that:

- receives DMs and mentions over Socket Mode
- forwards work to the shared SmolPaws turn API
- delivers claimed outbound messages and the final reply back to Slack

This app should look more like `apps/discord` than `apps/github`:

- long-running local process
- no Cloudflare Worker requirement
- local runner on `127.0.0.1:8788`

## Build Target

Phase 1:

- `message.im` for DMs
- `app_mention` for channels and threads
- `chat.postMessage` replies with `thread_ts`
- stable Slack-scoped conversation ids
- optional allowlists for workspace, channel, and user

Phase 2:

- richer Slack-native AI surfaces
- loading states or streaming
- bounded thread history where permissions justify it

## Planned Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Bolt app entrypoint and event handlers |
| `src/config.ts` | env parsing and allowlists |
| `src/slackContext.ts` | conversation-id and Slack metadata helpers |
| `src/threadContext.ts` | bounded thread-context reads |
| `src/agentServerClient.ts` | turn submission and outbound-claim adapter |
| `src/__tests__/...` | Slack ingress regression tests |

## Local Runtime Notes

- Prefer Socket Mode over HTTP webhooks.
- Load secrets from `~/.smolpaws/.env`.
- Use `SMOLPAWS_RUNNER_URL=http://127.0.0.1:8788` for local development.
- Do not request broad history scopes until there is code that needs them.
- Keep Slack replies thread-aware and idempotent.

## Documentation

- Architecture and implementation plan: [`../../docs/slack/README.md`](../../docs/slack/README.md)
- Operator setup notes: [`../../docs/slack/instructions.md`](../../docs/slack/instructions.md)
