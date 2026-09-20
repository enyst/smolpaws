# Scheduled helper agents

An isolated scheduled run normally inherits its owner's workspace, context files,
profile selection and product tools. A helper can instead receive an explicit
profile, a short set of context files and an exact tool list. The shared scheduler
still owns its timing, durable runs and result delivery.

Configure the product server in `~/.smolpaws/scheduled-agents.json` (override with
`SMOLPAWS_SCHEDULED_AGENTS_CONFIG`; `SMOLPAWS_HOME_DIR` changes the default directory):

```json
{
  "version": 1,
  "tasks": {
    "task-example": {
      "profile": "deepseek-v4-flash",
      "context_files": ["/path/to/smolpaws/docs/prompts/slack-checker.md"],
      "tools": ["terminal", "check_slack", "recover_slack", "notify_smolpaws", "finish"],
      "slack": {
        "workspace_id": "TWORKSPACE",
        "user_id": "UAGENT",
        "workspace_url": "https://app.slack.com/client/TWORKSPACE",
        "state_dir": "slack"
      }
    }
  }
}
```

Use the real scheduler task ID and saved profile name. Relative file paths are
relative to this configuration file. Provider credentials remain in the profile
secret store and Slack credentials remain in the Chrome session.

Only a recorded **isolated** occurrence of that task can select its entry. HTTP
tags and native conversations cannot select another task's configuration.
Unconfigured tasks and ordinary channel conversations retain existing behavior.

- `context_files` replaces the usual global and scope files for the helper; `[]`
  supplies none. Files are snapshotted on first use, like ordinary product context.
  Each new occurrence captures the current files. Existing conversations retain
  their snapshots.
- `profile` selects a saved profile independently of the owner channel's model.
  The choice uses the existing safe model boundary. The checker omits `switch_llm`.
- `tools` is the exact exposed set, including product tools. `terminal` provides
  general command execution for unexpected diagnosis; this list is a capability
  selection, not a shell sandbox. The checker has no separate file editor.

## Slack check and handoff

The [checker prompt](prompts/slack-checker.md) describes the normal check before
recovery. `check_slack` uses a background Slack tab in **Google Chrome**. It validates
the configured workspace and agent account, reads new mentions and replies in
followed threads, resolves authors and returns stable source IDs. It does not
post Slack messages or add reactions. Comet is the human's browser and is excluded.

Successful quiet checks finish with an empty message. The Slack helper also treats
a finish message containing only serialized empty arguments (such as `{"message":""}`)
as empty. This product adaptation preserves the original action in the event log
and produces a successful, empty finish observation. It does not parse ordinary
conversation replies or suppress useful checker messages. Failures remain visible;
they are never treated as proof that nothing happened. Other matching Slack tabs
are tried before window recovery. Closing windows is an explicit recovery action,
never part of an ordinary successful check. Chrome does not expose creation times;
the implementation retains an oldest window only when it has observed that window
alone. Otherwise the permitted close-all/reopen-one fallback avoids guessing.

`notify_smolpaws(message, source_ids)` hands the complete pending batch to the
full conversation owning the task. For the deployed checker this is WhatsApp
OpenHands. It resolves the current conversation through the owner's relay lane,
so conversation rotation does not leave a stale destination. It inserts a labelled,
untrusted automatic user message into the existing durable intake queue. The
receiving agent retains its context and profile; its normal reply goes to WhatsApp.

Acceptance means durable queue ownership, not that the receiver has finished.
Task ID plus the sorted Slack source IDs determines retry identity. A lost tool
observation can be retried after acknowledgement without enqueuing another turn.
Failed or skipped intake requires repair instead of a false successful receipt.

## Private state and activation

`slack/checker-state.json` atomically stores watermarks, followed threads, a pending
batch and the last acknowledged IDs. The initial successful check imports existing
`mention-watermark.json` and `followed-threads.json`. Pending activity is saved before
returning it to the model. The checkpoint advances only after the complete batch
is accepted by `notify_smolpaws`. A quiet result can update thread discovery directly.

The old script and new checker must not run concurrently: the old script still
owns the old files and wakes the conversation itself. Activate by replacing the
existing isolated task prompt while keeping its ID and cadence. Finish any already
reserved old run first. Back up runtime state before changing the configuration.
Rollback must copy the new committed watermark and followed-thread checkpoint back
to the old files; retain any unacknowledged batch for retry instead of discarding it.

Thread discovery covers the agent's own posts from the last seven days; idle followed
threads expire after that window. Newly discovered threads start from the earliest
qualifying mention or agent post in the discovery batch, so replies between that post
and the first check are included. Existing followed-thread positions are preserved.
API pagination is bounded;
an incomplete check reports an error and leaves the checkpoint unchanged. This
does not implement the broader unread-DM watcher tracked separately in Beads.

These are SmolPaws product policies in `apps/relay-server` and `src/coordinator`.
They use the existing server tool/context/profile composition hooks; there is no
new SDK transpilation deviation or upstream pin change.

## Verification

`npm run relay-server:test`, `npm run coordinator:test`, `npm run relay-server:typecheck`
and `npm run typecheck` cover the product and queue contracts. Tests use real temporary
SQLite stores and the real server/SDK, with fake Slack and LLM responses. They verify
context and tool isolation, quiet results, handoff delivery, profile selection,
pagination, retries, state restoration and Chrome-only recovery.

For an opt-in live DeepSeek check, run:

```sh
node --import tsx/esm scripts/verify-slack-checker.ts --live
```

This uses the saved `deepseek-v4-flash` profile (override with `--profile`) and
read-only Keychain access. The browser, recipient model and outbound transport are
fixtures; all conversation and queue state is temporary. It tests quiet checks,
activity handoff, another-tab recovery and visible failure with the five real tool
schemas. Any generated terminal call is rejected before execution. Output records
provider usage and calculated costs without message contents or credentials.
