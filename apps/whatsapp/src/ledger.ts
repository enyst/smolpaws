/**
 * WhatsApp message ledger.
 *
 * The bridge keeps its own SQLite record of chats and messages (the channel's ledger, `messages.db`),
 * separate from the durable Message Relay store. The ledger answers "what arrived, in which chat, since
 * when", and holds the monotonic dispatch cursor that used to live in the repo-relative
 * `data/router_state.json`. The relay store answers "what work is owed and settled".
 *
 * The schema is the legacy `src/db.ts` schema so an existing `~/.smolpaws/whatsapp/messages.db` keeps
 * working; the scheduled-task tables it already contains are left untouched for the scheduler.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export interface LedgerMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  media_path: string | null;
  media_type: string | null;
}

export interface StoreMessageInput {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  media?: { path: string; type: string } | undefined;
}

export class WhatsAppLedger {
  readonly db: Database.Database;

  constructor(ledgerPath: string) {
    if (ledgerPath !== ':memory:') mkdirSync(path.dirname(ledgerPath), { recursive: true });
    this.db = new Database(ledgerPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        media_path TEXT,
        media_type TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
      CREATE TABLE IF NOT EXISTS relay_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    for (const column of ['sender_name TEXT', 'media_path TEXT', 'media_type TEXT']) {
      try {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${column}`);
      } catch {
        // column already exists
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Record that a chat exists (for group discovery) without storing content. */
  touchChat(chatJid: string, timestamp: string, name?: string): void {
    if (name) {
      this.db
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
           ON CONFLICT(jid) DO UPDATE SET name = excluded.name,
             last_message_time = MAX(last_message_time, excluded.last_message_time)`,
        )
        .run(chatJid, name, timestamp);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           last_message_time = MAX(last_message_time, excluded.last_message_time)`,
      )
      .run(chatJid, chatJid, timestamp);
  }

  updateChatName(chatJid: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
      )
      .run(chatJid, name, new Date().toISOString());
  }

  storeMessage(input: StoreMessageInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages
           (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, media_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.chatJid,
        input.sender,
        input.senderName,
        input.content,
        input.timestamp,
        input.isFromMe ? 1 : 0,
        input.media?.path ?? null,
        input.media?.type ?? null,
      );
  }

  /**
   * Messages newer than the cursor in the given chats, excluding the cat's own outbound messages
   * (recognized by their `<assistant>: ` prefix, because the human shares the WhatsApp account).
   */
  getNewMessages(chatJids: readonly string[], afterTimestamp: string, assistantName: string): LedgerMessage[] {
    if (chatJids.length === 0) return [];
    const placeholders = chatJids.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, media_type
         FROM messages
         WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ?
         ORDER BY timestamp, id`,
      )
      .all(afterTimestamp, ...chatJids, `${assistantName}:%`) as LedgerMessage[];
  }

  getMessagesSince(chatJid: string, afterTimestamp: string, assistantName: string): LedgerMessage[] {
    return this.db
      .prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, media_type
         FROM messages
         WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
         ORDER BY timestamp, id`,
      )
      .all(chatJid, afterTimestamp, `${assistantName}:%`) as LedgerMessage[];
  }

  getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM relay_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO relay_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  /** Global dispatch cursor: the newest message timestamp already handed to the relay. */
  getDispatchCursor(): string {
    return this.getState('dispatch_cursor') ?? '';
  }

  setDispatchCursor(timestamp: string): void {
    if (timestamp > this.getDispatchCursor()) this.setState('dispatch_cursor', timestamp);
  }

  /** Per-chat "last message the agent saw" so the next prompt carries only the new tail. */
  getLastAgentTimestamp(chatJid: string): string {
    return this.getState(`last_agent_ts:${chatJid}`) ?? '';
  }

  setLastAgentTimestamp(chatJid: string, timestamp: string): void {
    this.setState(`last_agent_ts:${chatJid}`, timestamp);
  }
}
