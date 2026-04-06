import {
  areJidsSameUser,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

/**
 * Baileys still expects direct person-to-person sends in PN form.
 * For our self-chat, inbound events arrive on the LID thread, but outbound
 * replies need to target our PN JID to appear in the WhatsApp client.
 */
export function resolveOutboundChatJid(
  requestedJid: string,
  currentUser?: { id?: string | null; lid?: string | null },
): string {
  const jid = requestedJid.trim();
  if (!jid) {
    return requestedJid;
  }

  if (
    isJidGroup(jid) ||
    isJidNewsletter(jid) ||
    isJidStatusBroadcast(jid) ||
    !isLidUser(jid)
  ) {
    return jid;
  }

  const selfId = currentUser?.id ?? undefined;
  const selfLid = currentUser?.lid ?? undefined;
  const selfPnJid = selfId ? jidNormalizedUser(selfId) : null;
  if (!selfPnJid) {
    return jid;
  }

  const sameAsSelfPn = Boolean(selfId) && areJidsSameUser(jid, selfId);
  const sameAsSelfLid = Boolean(selfLid) && areJidsSameUser(jid, selfLid);

  return sameAsSelfPn || sameAsSelfLid ? selfPnJid : jid;
}
