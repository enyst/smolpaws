# tomcat — a sub-billed sidekick (proof of life)

A minimal second cat that runs a task through the **Codex CLI** (`codex exec`)
on Engel's **ChatGPT/Codex Pro subscription** — not the metered
`api.openai.com` Agents API. This proves a sidekick can ride the sub, through
the same Codex harness OpenAI ships in the CLI.

## Why this shape

- `api.openai.com/v1/agents` is the **API-key** door (billed at model API rates).
- The Codex CLI talks to `chatgpt.com/backend-api` with the **subscription**
  token in `~/.codex/auth.json` (`auth_mode: chatgpt`). That's the sub-billed
  door. Rather than reverse-engineer its edge headers, `tomcat` just shells out
  to `codex exec`, which already holds the sub auth + project context.

## Usage

```bash
node tomcat.mjs "your task"                 # task as arg
node tomcat.mjs --model gpt-6-astra "..."   # pick the Codex model
node tomcat.mjs --cd /path/to/repo "..."    # working root (default: cwd)
echo "task" | node tomcat.mjs               # task from stdin
```

Prints the agent's final answer plus a run summary (outcome, tokens, session id).

## Status

Proof-of-life. Runs **read-only** by design. Verified on `plan: pro`,
`gpt-5.6-sol`, returning correct answers with token/session accounting.

## Next steps (not built yet)

- Loosen sandbox deliberately (`workspace-write`) for real edits.
- Use `codex exec resume`/`fork` for multi-turn sidekick sessions.
- Or move to the `codex app-server` daemon protocol (has JSON-schema/TS
  bindings) + `codex agents` for concurrent subagents.
- Expose as a tool the main cat can call (delegate Astra-suited jobs).
