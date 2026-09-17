/** Product-owned Slack check and durable acknowledgement; no model or server credentials enter Chrome. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ChromeSlackBrowser, type SlackCheckerBrowser, type SlackRecoveryAction } from './slackBrowser.js';
export type { SlackCheckerBrowser, SlackRecoveryAction } from './slackBrowser.js';

export interface SlackCheckerOptions { workspace_id: string; user_id: string; workspace_url: string; state_dir: string }
interface FollowedThread { last_seen: string; added?: number; channel?: string; name?: string; since?: string }
interface Checkpoint { last_ts: string; followed: Record<string, FollowedThread> }
export interface SlackActivity {
  source_id: string; kind: 'mention' | 'reply'; ts: string; channel: string; channel_name: string;
  user: string; author_name: string; text: string; permalink: string;
}
interface Pending { items: SlackActivity[]; next: Checkpoint }
interface State extends Checkpoint { version: 1; workspace_id: string; user_id: string; pending?: Pending; last_acknowledged_source_ids?: string[] }
export type SlackCheckResult =
  | { status: 'quiet'; followed_threads: number }
  | { status: 'activity'; items: SlackActivity[]; source_ids: string[]; followed_threads: number }
  | { status: 'error'; error: string };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
const missing = (error: unknown): boolean => record(error) && error.code === 'ENOENT';
const locks = new Map<string, Promise<unknown>>();

function checkpoint(value: unknown): value is Checkpoint {
  return record(value) && timestamp(value.last_ts) && record(value.followed)
    && Object.entries(value.followed).every(([key, thread]) => /^[A-Z0-9]+:\d+(?:\.\d+)?$/.test(key)
      && record(thread) && timestamp(thread.last_seen)
      && (thread.added === undefined || typeof thread.added === 'number'));
}

function activity(value: unknown, workspace: string): value is SlackActivity {
  return record(value) && (value.kind === 'mention' || value.kind === 'reply')
    && timestamp(value.ts) && typeof value.channel === 'string' && /^[A-Z0-9]+$/.test(value.channel)
    && value.source_id === `slack:${workspace}:${value.channel}:${value.ts}`
    && ['channel_name', 'user', 'author_name', 'text', 'permalink'].every(key => typeof value[key] === 'string');
}

export class SlackChecker {
  private readonly statePath: string;
  private readonly browser: SlackCheckerBrowser;
  constructor(private readonly options: SlackCheckerOptions, browser?: SlackCheckerBrowser) {
    const url = new URL(options.workspace_url);
    if (!/^T[A-Z0-9]+$/.test(options.workspace_id) || !/^[UW][A-Z0-9]+$/.test(options.user_id)
      || url.origin !== 'https://app.slack.com' || url.pathname !== `/client/${options.workspace_id}`
      || url.search || url.hash) throw new Error('Invalid Slack checker workspace configuration.');
    this.statePath = path.join(options.state_dir, 'checker-state.json');
    this.browser = browser ?? new ChromeSlackBrowser(options.workspace_url);
  }

  private state(): State {
    try {
      const value: unknown = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (!checkpoint(value) || !record(value) || value.version !== 1 || value.workspace_id !== this.options.workspace_id
        || value.user_id !== this.options.user_id
        || (value.last_acknowledged_source_ids !== undefined && (!Array.isArray(value.last_acknowledged_source_ids)
          || !value.last_acknowledged_source_ids.every(id => typeof id === 'string')))
        || (value.pending !== undefined && (!record(value.pending)
          || !checkpoint(value.pending.next) || !Array.isArray(value.pending.items) || !value.pending.items.length
          || !value.pending.items.every(item => activity(item, this.options.workspace_id))))) {
        throw new Error('Invalid Slack checker state; preserve the file and repair it before retrying.');
      }
      return value as unknown as State;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const readLegacy = (name: string, fallback: unknown): unknown => {
      try { return JSON.parse(readFileSync(path.join(this.options.state_dir, name), 'utf8')); }
      catch (error) { if (missing(error)) return fallback; throw error; }
    };
    const watermark = readLegacy('mention-watermark.json', { last_ts: '0' });
    const followed = readLegacy('followed-threads.json', {});
    const legacy = { last_ts: record(watermark) ? watermark.last_ts : null, followed };
    if (!checkpoint(legacy)) throw new Error('Invalid legacy Slack watermark or followed-thread state.');
    return { version: 1, workspace_id: this.options.workspace_id, user_id: this.options.user_id, ...legacy };
  }

  private save(state: State): void {
    mkdirSync(this.options.state_dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.statePath);
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.statePath) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(fn);
    locks.set(this.statePath, work);
    try { return await work; }
    finally { if (locks.get(this.statePath) === work) locks.delete(this.statePath); }
  }

  pendingSourceIds(): string[] { return this.state().pending?.items.map(item => item.source_id) ?? []; }

  async acknowledge(sourceIds: string[]): Promise<void> {
    await this.exclusive(async () => {
      const state = this.state();
      const sameSet = (expected: string[]): boolean => expected.length > 0 && sourceIds.length === expected.length
        && new Set(sourceIds).size === sourceIds.length && sourceIds.every(id => expected.includes(id));
      if (sameSet(state.last_acknowledged_source_ids ?? [])) return;
      const expected = state.pending?.items.map(item => item.source_id) ?? [];
      if (!sameSet(expected)) throw new Error('Acknowledge exactly the complete pending Slack batch.');
      this.save({ version: 1, workspace_id: state.workspace_id, user_id: state.user_id,
        ...state.pending!.next, last_acknowledged_source_ids: sourceIds });
    });
  }

  async check(): Promise<SlackCheckResult> { return this.checkTabs('first'); }

  async recover(action: SlackRecoveryAction): Promise<SlackCheckResult> {
    if (action === 'try_other_tabs') return this.checkTabs('others');
    try {
      await this.browser.recover(action);
      return await this.check();
    } catch (error) { return { status: 'error', error: error instanceof Error ? error.message : 'Chrome recovery failed.' }; }
  }

  private async checkTabs(selection: 'first' | 'others'): Promise<SlackCheckResult> {
    return this.exclusive(async () => {
      try {
        const state = this.state();
        if (state.pending) return this.result(state.pending);
        const raw = await this.browser.evaluate(slackCheckScript(this.options, state), selection);
        if (raw === 'NO_SLACK_TAB') return { status: 'error', error: 'No matching Slack tab found in Google Chrome.' };
        if (raw === 'CHROME_TAB_EXECUTION_FAILED') return { status: 'error', error: 'Could not run the check in this Chrome Slack tab.' };
        let result: unknown;
        try { result = JSON.parse(raw); } catch { throw new Error('The Chrome Slack check returned invalid data.'); }
        if (record(result) && result.ok === false) {
          // Only our own codes are reflected; never return arbitrary browser content or a Slack session token.
          const code = typeof result.error === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(result.error) ? result.error : 'slack_check_failed';
          return { status: 'error', error: code };
        }
        if (!record(result) || result.ok !== true || !checkpoint(result.next) || !Array.isArray(result.items)
          || !result.items.every(item => activity(item, this.options.workspace_id))
          || new Set(result.items.map(item => item.source_id)).size !== result.items.length) {
          throw new Error('The Chrome Slack check returned invalid data.');
        }
        if (!result.items.length) {
          this.save({ ...state, ...result.next });
          return { status: 'quiet', followed_threads: Object.keys(result.next.followed).length };
        }
        const pending: Pending = { items: result.items, next: result.next };
        this.save({ ...state, pending });
        return this.result(pending);
      } catch (error) { return { status: 'error', error: error instanceof Error ? error.message : 'Slack check failed.' }; }
    });
  }

  private result(pending: Pending): SlackCheckResult {
    return { status: 'activity', items: pending.items, source_ids: pending.items.map(item => item.source_id),
      followed_threads: Object.keys(pending.next.followed).length };
  }
}

/** Runs entirely inside a logged-in Chrome Slack tab. Tokens stay in that tab. */
export function slackCheckScript(options: SlackCheckerOptions, state: Checkpoint): string {
  const input = { workspace: options.workspace_id, user: options.user_id, last_ts: state.last_ts, followed: state.followed };
  return `(function(input) {
    try {
      var config = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
      var team = (config.teams || {})[input.workspace];
      if (!team || !team.token) return JSON.stringify({ok:false,error:'slack_session_unavailable'});
      function call(method, params) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://app.slack.com/api/' + method, false);
        xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
        var body = Object.keys(params).map(function(key) { return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]); });
        xhr.send('token=' + encodeURIComponent(team.token) + '&' + body.join('&'));
        if (xhr.status !== 200) throw new Error(method + ':http_' + xhr.status);
        var result = JSON.parse(xhr.responseText);
        if (!result.ok) throw new Error(method + ':' + (result.error || 'api_error'));
        return result;
      }
      var auth = call('auth.test', {});
      if (auth.team_id !== input.workspace || auth.user_id !== input.user) throw new Error('slack_session_identity_mismatch');
      var now = Date.now() / 1000;
      var cutoff = now - 7 * 86400;
      var followed = {};
      Object.keys(input.followed).forEach(function(key) {
        var value = input.followed[key];
        if (Number(value.last_seen) > cutoff || Number(value.added || 0) > cutoff) followed[key] = value;
      });
      function search(query, since) {
        var matches = [];
        for (var page = 1; page <= 10; page++) {
          var result = call('search.messages', {query:query,sort:'timestamp',sort_dir:'desc',count:100,page:page});
          if (!result.messages || !Array.isArray(result.messages.matches)) throw new Error('search.messages:invalid_response');
          var batch = result.messages.matches;
          matches = matches.concat(batch.filter(function(m) { return Number(m.ts) > since; }));
          var pageCount = result.messages.pagination && result.messages.pagination.page_count;
          if (pageCount === undefined) pageCount = result.messages.paging && result.messages.paging.pages;
          if (batch.some(function(m) { return Number(m.ts) <= since; })
            || (typeof pageCount === 'number' ? page >= pageCount : batch.length < 100)) return matches;
        }
        throw new Error('search.messages:pagination_limit');
      }
      function thread(message, ownPost) {
        var channel = (message.channel || {}).id;
        if (!channel || !message.ts) throw new Error('search.messages:invalid_message');
        var root = message.thread_ts || ((message.permalink || '').match(/thread_ts=([0-9.]+)/) || [])[1] || message.ts;
        var key = channel + ':' + root;
        if (!followed[key]) followed[key] = {last_seen:ownPost ? String(now) : message.ts,added:now,channel:channel,name:(message.channel || {}).name || ''};
        return key;
      }
      var items = [];
      var seen = {};
      var newest = input.last_ts;
      function add(kind, message, channel, channelName, permalink) {
        var id = 'slack:' + input.workspace + ':' + channel + ':' + message.ts;
        if (seen[id] || message.user === input.user) return;
        seen[id] = true;
        items.push({source_id:id,kind:kind,ts:message.ts,channel:channel,channel_name:channelName || '',
          user:message.user || '',author_name:message.user || message.username || 'Unknown author',text:message.text || '',permalink:permalink || ''});
      }
      var mentions = search('<@' + input.user + '>', Number(input.last_ts));
      // Oldest first: tracking a newly mentioned thread must not skip later replies in the same batch.
      mentions.sort(function(a,b) { return Number(a.ts)-Number(b.ts); }).forEach(function(message) {
        var key = thread(message);
        if (Number(message.ts) > Number(newest)) newest = message.ts;
        add('mention', message, message.channel.id, message.channel.name, message.permalink);
      });
      search('from:<@' + input.user + '>', cutoff).forEach(function(message) { thread(message, true); });
      Object.keys(followed).forEach(function(key) {
        var parts = key.split(':');
        var value = followed[key];
        var baseline = value.last_seen;
        var cursor = '';
        for (var page = 0; page < 10; page++) {
          var result = call('conversations.replies', {channel:parts[0],ts:parts[1],oldest:baseline,limit:100,cursor:cursor});
          if (!Array.isArray(result.messages)) throw new Error('conversations.replies:invalid_response');
          result.messages.forEach(function(message) {
            if (!(Number(message.ts) > Number(baseline))) return;
            if (Number(message.ts) > Number(value.last_seen)) value.last_seen = message.ts;
            if (message.user === input.user || seen['slack:' + input.workspace + ':' + parts[0] + ':' + message.ts]) return;
            var permalink = call('chat.getPermalink', {channel:parts[0],message_ts:message.ts});
            add('reply', message, parts[0], value.name, permalink.permalink);
          });
          cursor = (result.response_metadata || {}).next_cursor || '';
          if (!cursor && !result.has_more) return;
          if (!cursor || page === 9) throw new Error('conversations.replies:pagination_limit');
        }
      });
      var names = {};
      items.forEach(function(item) {
        if (item.user) {
          if (!names[item.user]) {
            var user = call('users.info', {user:item.user}).user;
            if (!user) throw new Error('users.info:invalid_response');
            var profile = user.profile || {};
            names[item.user] = profile.display_name || profile.real_name || user.real_name || user.name || item.user;
          }
          item.author_name = names[item.user];
        }
      });
      return JSON.stringify({ok:true,items:items,next:{last_ts:newest,followed:followed}});
    } catch (error) {
      var message = error && error.message || 'slack_check_failed';
      return JSON.stringify({ok:false,error:/^[a-zA-Z0-9_.:-]{1,100}$/.test(message) ? message : 'slack_check_failed'});
    }
  })(${JSON.stringify(input)})`;
}
