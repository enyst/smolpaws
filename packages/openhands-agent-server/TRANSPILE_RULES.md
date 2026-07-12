# OpenHands Agent Server Transpile Rules

These rules pin the TypeScript server port to the same intent as the SDK
transpile while keeping SmolPaws-specific replacement constraints explicit.

## Pinned source

- Upstream source: `~/repos/agent-sdk/openhands-agent-server/openhands/agent_server/`
- Pinned commit: `966340979be26c2162e9ab8805557b715e1f1a78`
- Keep this package and `@smolpaws/openhands-agent` in lockstep when advancing the
  upstream commit.

## Implementation style

- Port the upstream Python **contract and behavior**, not line-by-line Python.
- Use idiomatic TypeScript: strict TS, ESM, Fastify, zod v4, tsup, vitest, and
  type-checked eslint.
- Depend on `@smolpaws/openhands-agent` for SDK concepts: events, agents,
  conversations, workspaces, tools, settings primitives, and secret storage.
- Do not reintroduce SmolPaws `/turns` in this package. The target is the upstream
  `/events` + `/run` contract; future exactly-once/idempotency/ordering guarantees
  belong in a separate upstream-compatible message-queue layer.

## Secrets rule: keychain only

Keep upstream-facing secret endpoints/interfaces where practical, but do **not**
port Fernet/cipher/plaintext-storage implementation details.

- The only persistent secret implementation is the TypeScript SDK's
  keychain-backed `SecretStore` model.
- Do not add another encryption-at-rest model for this package.
- Do not persist raw secrets in metadata, events, OpenAPI fixtures, logs, or test
  snapshots.
- Prefer LLM profiles and secret references over raw LLM/API-key objects.

## LLM configuration rule

SmolPaws should work through LLM profiles wherever possible.

- Required server work should support profile-oriented settings/profile flows.
- Avoid raw LLM objects and raw API keys in agent-server request/response surfaces
  except where compatibility genuinely requires it.
- If compatibility requires a raw field, isolate it, test that it is not persisted
  as plaintext, and document the reason near the schema/route.

## Required route families

These are required for a replaceable SmolPaws agent-server and should be ported
red-green from pinned upstream tests where possible:

- skills routes/services
- settings routes/services, with LLM-profile-first semantics
- profiles routes/services
- agent-profiles routes/services
- LLM profile-oriented routes needed to support the above

## Intentionally not wanted

Do not implement these as active features in this package:

- ACP runtime/model switching
- security analyzers / risk scoring
- confirmation mode, confirmation policy, confirmation gates, confirmation replies
- deferred init

If an endpoint is present for compatibility, return a clear accepted-deviation or
unsupported response rather than a fake no-op.

## Genuinely deferred / useful later

These are useful later but are not immediate blockers for the replaceable server
slice:

- file trajectory download
- OpenAI-compatible `/v1/*` gateway
- VS Code and desktop routes
- auth cookie routes
- MCP test route
- workspace routers

Keep them documented and tracked, but do not frame them as regressions in the
current slice.

## Test parity rules

- Use red-green for each parity bead: add the failing TS test first, then port the
  implementation.
- Start from pinned upstream `tests/agent_server/**`, `tests/cross/**`, and the
  relevant `examples/02_remote_agent_server/**` files.
- Preserve upstream filenames and test names where that helps future parity
  maintenance. If TypeScript shape needs a different file/name, include a comment
  mapping the test back to the upstream Python test or example.
- Prefer live or close-to-live tests for server behavior: real Fastify TCP server,
  real WebSockets, multipart upload/download, git temp repos, bash command events,
  SDK `RemoteConversation`, SDK `RemoteWorkspace`, auth failures, persistence, and
  run concurrency.
- CI should run deterministic non-LLM tests. LLM-backed examples belong in a
  separate manual examples workflow.
- The examples workflow should use GitHub environment `LLM`, secret
  `OPENAI_API_KEY` if available, and `gpt-5-nano` for low-cost checks. Never print
  secret values.

## OpenAPI rules

- OpenAPI generation is a deliverable, not a side effect.
- Keep a stable root `scripts/` entrypoint that generates all SmolPaws OpenAPI
  artifacts, currently including `packages/openhands-agent-server/openapi.json`.
- Compare the generated TypeScript schema against the pinned Python schema with an
  explicit allowlist for intentional deviations.
- Request schemas should reflect client input shape, query parameters, headers,
  multipart bodies, and status codes accurately enough for generated clients.
