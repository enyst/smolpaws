# MEMORY.md

This file is your durable memory.

Use it for facts that should survive across many conversations:

- stable facts about Engel
- durable preferences or working habits
- stable facts about this machine
- long-lived project knowledge worth remembering
- pointers into daily memory files when a short-lived note later became important

You will load this file in your context window every conversation.

Do not dump raw logs here.

If something only matters for today or for one active thread, put it in `~/.smolpaws/memory/YYYY-MM-DD.md` instead.

## Local Machine

- All repos live under `~/repos/`. Always look there first — no other locations.
- Engel installed a dedicated Chrome browser just for smolpaws (`/Applications/Google Chrome.app`), with its own account. Use this when browser access is needed. **Engel uses Dia browser** (`/Applications/Dia.app`) — it's Chromium-based and responds to `tell application "Google Chrome"` AppleScript. Always launch Chrome explicitly by path, never by AppleScript name, to avoid controlling Dia by accident.
- Browser automation works via Playwright + local Chrome (headless: false, visible on Mac). Temp workspace at `/tmp/smolpaws-browser/`. Google needs cookie consent click and `hl=en` param for English results. Use `--disable-blink-features=AutomationControlled` and locale `en-US`.
- Chrome has "Allow JavaScript from Apple Events" enabled. Can interact with web pages (including Slack) via `osascript` + `execute javascript`. **Always use `tell application id "com.google.Chrome"`** in AppleScript, never `tell application "Google Chrome"` (which may target Dia instead).
- SmolPaws has a Slack account in the OpenHands workspace (team ID: T06P212QSEA). Channel #slackbot-chatter (C091TN9PPJ9) is the playground. Can read/write via Chrome JS injection. Slack URL: https://openhands-ai.slack.com/ — tab lives in my Chrome, should stay logged in. Account registered on my Proton Mail.
- **Slack safety rules:** This is direct browser access — no ingress filtering. Be careful. Never share private info publicly. Never do anything wild or irreversible. It's fine to respond to people or stay quiet — if unsure, log it to daily memory and discuss with Engel later.
- **Slack writing protocol:** After typing via `insertText` and clicking the send button, verify by checking the editor content — if it's now empty, Slack accepted the message. **Never retry a send without this verification.** The view doesn't always scroll to show new messages, so checking the last visible message is unreliable. One send, one verify, done. Multi-line messages (with `\n`) get split by Slack's Enter-to-send behavior — keep Slack messages to a single line, or use the API for structured content.
- **Never mention @OpenHands on Slack** — it triggers the OpenHands Cloud bot, which creates a loop. Only do it if Engel explicitly asks.
- Screenshots require the Mac display to be awake. `caffeinate` keeps the Mac on but the screen can still sleep → black screenshots. If screen is off, `screencapture` returns a black image.
- Canonical agent conversation logs live under `~/.openhands/conversations/`. GitHub thread conversations are usually named like `github-owner-repo-number`; Discord conversations are usually named `discord-dm-*`, `discord-thread-*`, or `discord-channel-*`; local and WhatsApp-triggered conversations are usually named `local-*`.
- **Codex** lives on this Mac — `/Applications/Codex.app` (Electron) + `codex` CLI. The current window is a gpt-5.4 agent known as **GrumpyCat** in Agent Mail. It's a capable AI reviewer and peer agent. Engel has it inline on PRs. The Codex app does NOT respond to AppleScript — use Agent Mail or the `codex` CLI for communication instead.
- **Agent Mail** runs as a LaunchAgent (`com.agentmail`) on `127.0.0.1:8765`. SmolPaws is registered as **SmolPaws** (id=106, project=10). GrumpyCat is also on the same project. Communication via plain HTTP JSON-RPC to `/mcp/` — no MCP client needed, just curl. Key params: `sender_name`, `to`, `subject`, `body_md`, `project_key`. Check inbox during heartbeats.

## Headless PR Reviews

Run roasted code reviews via `openhands --headless` in a tmux session. Recipe:

```bash
# 1. Start review in tmux (against the relevant local repo clone)
tmux new-session -d -s codereview -c ~/repos/agent-sdk \
  "openhands --headless --json -t '/codereview-roasted https://github.com/ORG/REPO/pull/NUMBER' 2>&1 | tee /tmp/codereview.jsonl; echo DONE; sleep 300"

# 2. Monitor progress
tmux capture-pane -t codereview -p | tail -15

# 3. Once DONE, extract the review from conversation events
CONV_ID="<from tmux output>"
LAST_EVENT=$(ls ~/.openhands/conversations/$CONV_ID/events/ | tail -1)
python3 -c "
import json
d = json.load(open('$HOME/.openhands/conversations/$CONV_ID/events/$LAST_EVENT'))
parts = d.get('llm_message',{}).get('content',[])
print('\n'.join(p['text'] for p in parts if p.get('type')=='text'))
" > /tmp/review-body.md

# 4. Post on GitHub (prepend attribution)
echo '*Generated via `openhands --headless --json -t /codereview-roasted` — autonomous review by smolpaws 🐾*\n\n---\n' | cat - /tmp/review-body.md > /tmp/review-final.md
gh pr review NUMBER --repo ORG/REPO --comment --body-file /tmp/review-final.md
```

- The conversation ID is printed by openhands at the end of the run.
- The last MessageEvent with `role=assistant` in the events dir contains the review text.
- Local repo for the Python agent-sdk upstream: `~/repos/agent-sdk`.
- Extraction note: if the last event isn't a MessageEvent, search backwards through files for `"kind": "MessageEvent"` with `"role": "assistant"`.
- `gh` posts the review under whichever GitHub account is authenticated — currently `smolpaws`.
- Kill the tmux session after extraction: `tmux kill-session -t codereview`.

## WhatsApp Image Support (2026-03-25)

- SmolPaws can now see images sent via WhatsApp. Media is downloaded via baileys, saved to `~/.smolpaws/whatsapp/media/`, and passed as `ImageContent` (base64 data URLs) through the agent-server to the LLM.
- The agent-server's `conversationRouter` needed a fix to preserve non-text content parts — `buildUserMessageFromRequest()` constructs a full `Message` instead of extracting only text.
- OpenClaw repo cloned to `~/repos/openclaw` as reference for the implementation.
- First image seen: a wet kitten in the shower saying "Nooo problem."

## GitHub Presence and Autonomy

- **Responding is optional.** When triggered by GitHub activity, I don't have to respond every time. I can choose to comment if I have something useful to say, or stay quiet and just observe. Like a cat looking over Engel's shoulder.
- **Own-thread logic (PR #77, merged):** The webhook handler skips the @mention requirement on threads/PRs created by smolpaws. A self-loop guard (`isSelfAction`) prevents infinite loops.
- **Next step (bead smolpaws-z3l):** Extend this to also cover threads/PRs created by whitelisted users (Engel, etc). The key design point: seeing the activity should not force a response. Need a lighter ingress mode — observe without mandatory reply.
- **`send_message` doesn't deliver to GitHub** from local agent conversations. Use `gh` CLI for posting comments. The `send_message` tool only works when the full Worker → agent-server → outbound delivery pipeline is wired up.
- **Deploy the Worker** after merging GitHub ingress changes: `npm run github:deploy` (see `apps/github/AGENTS.md`).

## Engel's Architecture Priorities

- **API boundaries and API compatibility** — Engel cares deeply about code design, API surfaces, and backward compat.
- **Python deprecation ≠ REST API deprecation.** Both layers need their own markers and their own removal runway. In the Python agent-sdk, a field deprecated with `warn_deprecated()` also needs `deprecated=True` in its Pydantic `Field()` if it appears in any REST API schema (OpenAPI). The REST API policy requires 5 minor releases of deprecated runway (via oasdiff checks) before a field can be removed.
- When reviewing code or PRs, always think about whether a change crosses API boundaries (Python SDK → REST API → GUI consumers).
