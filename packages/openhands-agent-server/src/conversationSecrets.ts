import type { SecretRef } from '@smolpaws/openhands-agent';

import type { StartConversationRequest } from './models.js';

const safeSecretNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

export function conversationSecretRef(conversationId: string, name: string): SecretRef {
  return { service: 'openhands', account: `conversation:${conversationId}:secret:${name}` };
}

export function withoutConversationSecrets(request: StartConversationRequest): StartConversationRequest {
  const sanitized: StartConversationRequest = { ...request };
  delete sanitized.secrets;
  return sanitized;
}

export function extractConversationSecrets(input: Record<string, unknown> | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (input === undefined) return result;
  for (const [name, raw] of Object.entries(input)) {
    if (!safeSecretNamePattern.test(name)) {
      throw new Error(`invalid_conversation_secret_name:${name}`);
    }
    const value = secretValue(raw);
    if (value !== null) result.set(name, value);
  }
  return result;
}

export function extractConversationSecretUpdates(input: Record<string, unknown>): { readonly set: Map<string, string>; readonly delete: readonly string[] } {
  const set = new Map<string, string>();
  const deleted: string[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (!safeSecretNamePattern.test(name)) {
      throw new Error(`invalid_conversation_secret_name:${name}`);
    }
    if (raw === null) {
      deleted.push(name);
      continue;
    }
    const value = secretValue(raw);
    if (value !== null) set.set(name, value);
  }
  return { set, delete: deleted };
}

function secretValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (!isRecord(raw)) return null;
  const value = raw.value ?? raw.secret;
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
