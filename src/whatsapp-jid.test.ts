import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveOutboundChatJid } from './whatsapp-jid.js';

test('resolveOutboundChatJid rewrites self-chat LID sends to PN', () => {
  assert.equal(
    resolveOutboundChatJid('259279391080479@lid', {
      id: '46720459794:2@s.whatsapp.net',
      lid: '259279391080479:2@lid',
    }),
    '46720459794@s.whatsapp.net',
  );
});

test('resolveOutboundChatJid keeps non-self LID targets unchanged', () => {
  assert.equal(
    resolveOutboundChatJid('999999999999999@lid', {
      id: '46720459794:2@s.whatsapp.net',
      lid: '259279391080479:2@lid',
    }),
    '999999999999999@lid',
  );
});

test('resolveOutboundChatJid keeps group chats unchanged', () => {
  assert.equal(
    resolveOutboundChatJid('123456789-123456@g.us', {
      id: '46720459794:2@s.whatsapp.net',
      lid: '259279391080479:2@lid',
    }),
    '123456789-123456@g.us',
  );
});
