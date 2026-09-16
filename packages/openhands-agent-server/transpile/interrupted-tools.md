# Interrupted tool recovery on server restart

Current correction, September 16, 2026. Tracking: `smolpaws-02x`.

## Source and disposition

`PORT`: the crash-recovery behavior introduced by OpenHands/software-agent-sdk
[PR #1554](https://github.com/OpenHands/software-agent-sdk/pull/1554) is already included
in the canonical vendored pin. Source: `openhands-agent-server/openhands/agent_server/event_service.py`,
`EventService.start()`, and `tests/agent_server/test_event_service.py`,
`TestEventServiceStartWithRunningStatus`. The upstream pin and SDK runtime behavior
do not change. The SDK manifest revision only registers the canonical
`DEV-SERVER-008` policy ID, then the package is reproducibly re-vendored.

Python checks a restored `RUNNING` status, scans the full log for unmatched actions,
checks for an existing result with the same tool-call identity, and appends an internal
`AgentErrorEvent` explaining the restart. The TypeScript server previously only
constructed the restored SDK state: a crash between an `ActionEvent` and its observation
left a permanently incomplete provider tool exchange. A later retry produced a provider
protocol error instead of resuming the conversation.

The correction belongs to the server restoration lifecycle. The existing SDK already
detects unmatched actions and orders completed tool-call/result groups in native
Anthropic and proxy requests, including results appended after a queued user prompt.
No automatic repair is added to arbitrary SDK conversations or live runs.

## Adaptation and safety

`DEV-SERVER-008` records the intentional adaptation. The server restores only after
acquiring the conversation lease and completes repair before its readiness promise
allows requests. TS does not persist the Python execution status; unmatched calls
are therefore the recovery signal even if a previous build already accepted a retry
and recorded a `ConversationErrorEvent`.

Every unresolved call in a parallel batch receives a truthful unknown-outcome result;
none is automatically reexecuted. Python historically repaired the first action and
could resume the rest, which is unsafe when parallel commands may have caused side
effects before their observations were saved. Existing observations, user rejections
and tool errors prevent replacement, including an imported result matching by
`tool_call_id` when its `action_id` differs. Repair uses SDK events and persistence,
and does not add a separate store, replay queue, tool runner or error type.

Appended tool errors are not new conversation-error notices to WhatsApp. Existing
conversation errors remain visible in history. No LLM call or token/cost change occurs
until the caller requests continuation. Errors while loading or repairing release
claimed leases, and the server can still be closed after failed startup.

## Evidence

`src/__tests__/orphanedTools.test.ts` uses the real server, profile-created SDK Agent,
event log and restart lifecycle, mocking only final provider HTTP for continuation.
The zero-result and partial-parallel-result cases failed before the port because no
repair events were saved; the fully completed case passed. The regression checks
complete adjacent provider results, preservation of completed output and old errors,
queued retry ordering, no interrupted tool execution, no startup provider call,
idempotent repeated restart and exact accounting across restoration.

An isolated live Haiku test through the eval proxy also restored a partial tool batch
with a saved user retry and prior conversation error, then finished successfully with
one provider completion (1,176 input and 62 output tokens). Seven historical event
files remained byte-identical, the interrupted command was not executed, a second
restart added nothing, and persisted provider usage matched accumulated metrics.
No production conversation or Fable request was used for this proof.

Run package CI, root typecheck and coordinator/product-host regressions. HTTP routes
and generated OpenAPI remain unchanged. This note is the current source-backed
correction; older frozen interval reviews must not be rewritten to imply the behavior
was implemented earlier.
