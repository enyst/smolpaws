# WhatsApp Message Relay bridge

Standalone Baileys bridge on SmolPaws' durable Message Relay. Same shape as `apps/slack`: own process,
no `BaseBridgeAdapter`, no `bridgeRegistry`, no `turnClient`, no `/turns`. Do not reintroduce them.

Read [`docs/whatsapp/README.md`](../../docs/whatsapp/README.md) for the flow, setup, pairing, launchd,
verification, and rollback.

## Files

| File | Owns |
|---|---|
| `src/config.ts` | env, paths under `~/.smolpaws/whatsapp`, registered chats, trigger pattern |
| `src/ledger.ts` | `messages.db`: chats, messages, media refs, per-chat dispatch cursors |
| `src/handler.ts` | pure policy: who the cat answers, transcript building, lane identity, per-scope workspace |
| `src/adapter.ts` | `WhatsAppBridge`: Baileys socket lifecycle, ingest, poll loop, typing, `sendText` |
| `src/deliveryTarget.ts` | `WhatsAppDeliveryTarget`: prefix, chunking, `chat.sendMessage` |
| `src/relayRuntime.ts` | `WhatsAppRelayRuntime` over the shared `src/coordinator/relayRuntime.ts`; delivers `send_message` actions and the terminal response |
| `src/index.ts` | entrypoint: workspace/ingress defaults and signals; context belongs to the product server |
| `src/auth.ts` | device linking: QR or `--phone` pairing code |

## Invariants

- Ingress success = the intake row is committed. Cursors advance only after `runtime.accept()` resolves.
- One chat's failure never blocks another chat (per-chat cursors).
- Conversation ids come from the `whatsapp-relay:v1` namespace only. Never reuse legacy session ids.
- Outbound text always carries the `smolpaws: ` prefix; the ledger filters the cat's own messages by it.
- After `send_attempted` is durable, an exception is `delivery_unknown`; never blindly resend.
- The bridge never pairs inline. Auth required → log, notify, exit 1 so launchd shows it.

## Tests

```bash
npm run typecheck --prefix apps/whatsapp
npm run test --prefix apps/whatsapp
```
