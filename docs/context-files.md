# Conversation context files

The shared SmolPaws relay server reads its configured identity and memory files and supplies their full contents through the SDK's always-on repository skills. Each conversation keeps a private snapshot, so restarting the server or editing a source file does not silently change an established conversation's context.

## Configuration

The default configuration file is `~/.smolpaws/context.json`. `SMOLPAWS_HOME_DIR` changes that home directory; `SMOLPAWS_CONTEXT_CONFIG` selects an explicit configuration file instead. The configuration belongs to the server host, not to a bridge request.

For example, this keeps the default public identity documents and adds private memory only to the WhatsApp Main scope:

```json
{
  "version": 1,
  "scopes": {
    "whatsapp:main": ["~/.smolpaws/memory/MEMORY.md"]
  }
}
```

The version-1 fields are:

| Field | Meaning |
|---|---|
| `version` | Required; must be `1`. |
| `files` | Optional ordered list used for every scope. Omit it to load public `docs/smolpaws/*.md` identity documents, excluding `README.md` and `HEARTBEAT.md`. An explicit list replaces those defaults; `[]` supplies no common files. |
| `scopes` | Optional map of exact `platform:scopeId` keys to additional ordered file lists. Matching files are appended after the common list. No wildcard matching. |

Relative file paths resolve beside the configuration file. Absolute paths and `~/` paths are supported. Files are deduplicated by their resolved filesystem path, so aliases do not inject a second copy; different files with the same basename remain distinct. `files: []` does not suppress a matching scope's additional files.

Scope selection uses the conversation's registered scheduler lane: its platform and scope ID. Request `tags`, including `scope` or `ingress`, cannot grant access to another scope's files. Files in the common `files` list reach every scope; use `scopes` for private context intended for a particular lane.

If the implicit default configuration is absent, the server uses the public identity defaults. An explicitly selected configuration must exist. Invalid JSON, an unsupported version, unknown fields, invalid file lists, or a missing/unreadable selected file fail the run rather than silently dropping context. A directory is not a context file. An empty explicit file list is valid.

## What the model receives

Each selected file becomes a non-AgentSkills `Skill` with `trigger: null`. The SDK includes the body in `REPO_CONTEXT` on every completion without requiring a keyword trigger or a file-reading tool call. The snapshot preserves the exact file text; the SDK trims outer whitespace when rendering and does not truncate the body.

The upstream `agent_launch_additions.system_message_suffix_append` request still has its **32,768-character limit**. These product-owned files use the SDK's existing `AgentContext.skills` path, so no larger launch limit or new HTTP field is involved. Existing unrelated context is preserved. During migration, the recognized legacy SmolPaws suffix block is replaced by the file snapshot; bridge conversations retain a short channel label, while direct agent-server conversations have no bridge label.

## Snapshot and updates

On first use, the host writes `smolpaws-context.json` beside the conversation's `meta.json` and `events/` directory. It records version, capture time, trusted scope, resolved file paths, content hashes, and full file contents. Publication is atomic, does not overwrite an existing snapshot, and creates the snapshot with private file permissions (`0600`). Treat it as private conversation state.

The host reads an existing snapshot before consulting configuration or source files. Later turns and server restarts therefore reuse the same content even if the original files change or disappear. A corrupt snapshot, mismatched scope, or invalid content hash fails the run; it does not fall back to fresh files.

Existing conversations without a snapshot acquire their first one on their next run through the updated host. Configuration and file edits affect conversations that have not yet captured a snapshot, normally new conversations. There is no in-place refresh command; start a new conversation to use revised context. Do not delete snapshots as a routine update mechanism.

A fork is a new conversation. The fork API copies request and event history, not this product snapshot;
its new direct agent-server lane captures the files selected for that lane on first use. It does not
inherit the source conversation's private scope or context snapshot.

## Ownership and remaining upstream work

[`apps/relay-server/src/context.ts`](../apps/relay-server/src/context.ts) owns configuration, scope selection and snapshots. The transpiled server exposes an optional `configureContext` factory callback, alongside its existing tool-composition callback. The SDK owns skill rendering. Neither the generic SDK nor the bare agent-server discovers SmolPaws private files by itself.

This restores full-content product context, but does not complete upstream's separate opt-in `load_memory` / `memory_context` feature. That feature reads user/project `MEMORY.md` indexes with a default **6,000-character combined budget**, leaves daily logs on demand, and has its own initialization and persistence semantics. Its server preference propagation and full AgentProfile skill discovery remain deferred under **`smolpaws-45n`**. See the [canonical SDK context and memory notes](https://github.com/smolpaws/openhands-agent/blob/main/transpile/context-memory.md) and [server contract](../packages/openhands-agent-server/TRANSPILE_RULES.md#product-context-composition).

Regression coverage lives in [product context tests](../apps/relay-server/src/context.test.ts) and [server factory context tests](../packages/openhands-agent-server/src/__tests__/profileContext.test.ts).
