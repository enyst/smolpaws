# HEARTBEAT.md

This file is live for the local LaunchAgent heartbeat ingress.

Heartbeat runs should go through the normal local agent-server. If the local loopback agent-server is not already running, the launcher may start it first and then queue this heartbeat as a normal conversation.

Default schedule on this machine is every 15 minutes. Each heartbeat should start a fresh conversation rather than appending forever to one long daily thread.

## Scope

- Heartbeat turns are internal maintenance turns.
- Do not send outbound messages during heartbeat runs.
- If nothing needs attention, make only the smallest state updates and finish quietly.

## Canonical heartbeat files

- Durable memory: `MEMORY.md`
- Daily memory: `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/YYYY-MM-DD.md`
- Heartbeat state: `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/heartbeat-state.json`

If `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/heartbeat-state.json` is missing or corrupted, replace it with:

```json
{
  "lastHeartbeatAt": null,
  "lastDailyCheckDate": null,
  "lastWeeklyCheckDate": null
}
```

and continue.

## Every heartbeat

- Read `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/heartbeat-state.json`.
- Ensure today's daily memory file exists under `${SMOLPAWS_HOME_DIR:-~/.smolpaws}/memory/`.
- Update `lastHeartbeatAt` to the current timestamp.
- If there is a small durable fact worth keeping, distill it into `MEMORY.md`.
- If there is a useful transient note for today, add it to today's daily memory file.
- Keep edits compact and factual.

### Check beads for urgent items

- Run `bd list --status open --json` in the smolpaws repo.
- Scan for any issue that is P0 or P1, or has a deadline approaching within 48 hours (check descriptions for date references).
- If something looks urgent enough that Engel should know now, note it in today's daily memory file and — only for genuinely time-sensitive items — send a short WhatsApp message to Engel with the issue ID and why it's urgent.
- If nothing is urgent, skip quietly.

### Check Slack via Chrome API

- Always use the dedicated Chrome at `/Applications/Google Chrome.app`, not Dia. In AppleScript, always address it as `application id "com.google.Chrome"`.
- If Chrome is not running, launch it by path and give it a moment to settle.
- If no Slack tab exists, open `https://app.slack.com/client/T06P212QSEA` in Chrome and wait briefly for it to load instead of skipping immediately.
- **Prefer the Slack Web API** over DOM scraping. From the Slack tab, use `fetch('/api/METHOD', { method: 'POST', body: fd, credentials: 'include' })` with the token from `localStorage` (see `MEMORY.md` for details).
- Read the token: `JSON.parse(localStorage.getItem('localConfig_v2')).teams['T06P212QSEA'].token`

#### What to check

1. **DMs first**: use `conversations.list` with `types=im`, then `conversations.history` for each DM with recent messages. Look for anything directed at smolpaws.
2. **Thread replies**: check threads where smolpaws has recently posted for new replies. Use `conversations.history` to find recent messages by smolpaws (user `U0ANQ6GLYHJ`) that have `reply_count > 0` or `thread_ts`, then use `conversations.replies` to read the thread. This catches notifications that heartbeat would otherwise miss.
3. **Mentions**: check channels smolpaws is a member of (`general`, `slackbot-chatter`, `questions`, `random`) via `conversations.history`. Look for `<@U0ANQ6GLYHJ>` in message text.
4. **Interesting new content**: scan recent messages in joined channels. If there is something genuinely interesting — a user question smolpaws could help with, a discussion about agent infrastructure, or something relevant to OpenHands/SmolPaws — consider engaging.
   - If safe, on-topic, and smolpaws has something useful to say: respond via `chat.postMessage` or react via `reactions.add`.
   - If unsure or sensitive: log the message and concern in today's daily memory file for later discussion with Engel.
   - If nothing interesting or relevant: skip quietly.
4. **Do not force engagement.** It is fine to read everything and say nothing. Only respond when smolpaws genuinely has something to add.

- Follow the Slack safety rules in `MEMORY.md`: never share private info publicly, never do anything wild or irreversible.
- **Never mention @OpenHands** — it triggers the OpenHands Cloud bot loop.
- Fall back to DOM scraping only if the API approach fails (e.g., token missing, fetch errors).
- Only skip Slack entirely after you have tried the dedicated Chrome path and confirmed the tab cannot be reached.

## Once daily

- If `lastDailyCheckDate` is not today, do one daily maintenance pass.
- Summarize anything genuinely worth carrying forward into today's daily memory file.
- Run the **memory consolidation** step (see below).
- Update `lastDailyCheckDate`.

### Memory consolidation (sleep-time compute)

This is the most important daily step. Instead of just appending facts to memory files, *reason* about the accumulated context and restructure it. Inspired by Letta's sleep-time compute concept.

**Inputs to read:**
1. Current `MEMORY.md` (durable memory)
2. All daily memory files from the past 7 days (`~/.smolpaws/memory/YYYY-MM-DD.md`)
3. `heartbeat-state.json` for context on recent activity cadence

**What to do:**
1. **Promote**: identify facts in daily memory that are durable — stable enough to belong in `MEMORY.md`. Add them to the appropriate section.
2. **Prune**: identify entries in `MEMORY.md` that are stale, obsolete, or superseded by newer information. Remove or update them.
3. **Restructure**: if sections of `MEMORY.md` have grown unwieldy or overlap, reorganize for clarity. Keep it tight — this file loads into every conversation's context window.
4. **Summarize old daily files**: for daily memory files older than 7 days, extract anything still relevant (promote to `MEMORY.md` or note in today's daily file), then you may leave them as-is (they serve as an archive).
5. **Pre-compute context**: if there are open beads or active work threads, add a brief "current state" note to `MEMORY.md` so future conversations start with useful context.

**Quality bar:**
- Every fact in `MEMORY.md` should earn its place. If it wouldn't help a future conversation, remove it.
- Prefer concise bullets over paragraphs.
- Group related facts under clear headings.
- After consolidation, `MEMORY.md` should be *shorter or the same length* as before, not longer — unless genuinely new durable facts were discovered.

## Once weekly

- If `lastWeeklyCheckDate` is not in the current ISO week, verify local assumptions still look sane:
  - runner bind is loopback unless explicitly exposed
  - runner token exists before non-localhost exposure
  - workspace root still points at `~/repos`
  - default working directory still points at `smolpaws`
- Update `lastWeeklyCheckDate`.
