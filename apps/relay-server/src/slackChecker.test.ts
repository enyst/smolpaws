import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { ChromeSlackBrowser } from './slackBrowser.js';
import { SlackChecker, slackCheckScript, type SlackCheckerBrowser, type SlackCheckerOptions, type SlackActivity } from './slackChecker.js';

function item(ts = '12'): SlackActivity {
  return { source_id: `slack:T123:C123:${ts}`, kind: 'mention', ts, channel: 'C123', channel_name: 'general',
    user: 'U456', author_name: 'A Slack user', text: 'hello', permalink: `https://app.slack.com/archives/C123/p${ts}` };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'smolpaws-slack-checker-'));
  const options: SlackCheckerOptions = { workspace_id: 'T123', user_id: 'U123', workspace_url: 'https://app.slack.com/client/T123', state_dir: root };
  writeFileSync(path.join(root, 'mention-watermark.json'), JSON.stringify({ last_ts: '10' }));
  writeFileSync(path.join(root, 'followed-threads.json'), '{}');
  const calls: { script: string; selection: string }[] = [];
  const recoveries: string[] = [];
  let response: string | Error = JSON.stringify({ ok: true, items: [item()], next: { last_ts: '12', followed: {} } });
  const browser: SlackCheckerBrowser = {
    async evaluate(script, selection) { calls.push({ script, selection }); if (response instanceof Error) throw response; return response; },
    async recover(action) { recoveries.push(action); },
  };
  return { root, options, calls, recoveries, browser, checker: new SlackChecker(options, browser),
    response: (value: string | Error) => { response = value; },
    state: () => JSON.parse(readFileSync(path.join(root, 'checker-state.json'), 'utf8')),
    close: () => rmSync(root, { recursive: true, force: true }) };
}

test('pending findings survive process restart; checkpoint advances only after exact complete acknowledgement', async () => {
  const f = fixture();
  try {
    f.response(JSON.stringify({ ok: true, items: [item(), item('13')], next: { last_ts: '13', followed: { 'C123:12': { last_seen: '13' } } } }));
    const result = await f.checker.check();
    assert.equal(result.status, 'activity');
    assert.equal(f.state().last_ts, '10');
    assert.equal(f.state().pending.next.last_ts, '13');
    const restored = new SlackChecker(f.options, f.browser);
    assert.deepEqual(await restored.check(), result);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(restored.pendingSourceIds(), [item().source_id, item('13').source_id]);
    await assert.rejects(restored.acknowledge([item().source_id]), /complete pending/);
    await assert.rejects(restored.acknowledge([item().source_id, item().source_id]), /complete pending/);
    await restored.acknowledge([item('13').source_id, item().source_id]);
    assert.equal(f.state().last_ts, '13');
    assert.equal(f.state().pending, undefined);
    assert.equal(JSON.parse(readFileSync(path.join(f.root, 'mention-watermark.json'), 'utf8')).last_ts, '10', 'legacy files are preserved');
  } finally { f.close(); }
});

test('acknowledgement retries survive restart and leave a newer pending batch untouched', async () => {
  const f = fixture();
  try {
    await f.checker.check();
    await f.checker.acknowledge([item().source_id]);
    const restored = new SlackChecker(f.options, f.browser);
    await restored.acknowledge([item().source_id]);
    f.response(JSON.stringify({ ok: true, items: [item('14')], next: { last_ts: '14', followed: {} } }));
    await restored.check();
    await restored.acknowledge([item().source_id]);
    assert.deepEqual(restored.pendingSourceIds(), [item('14').source_id]);
    assert.equal(f.state().last_ts, '12');
    await assert.rejects(restored.acknowledge(['unknown']), /complete pending/);
  } finally { f.close(); }
});

test('quiet checks persist followed-thread discovery and preserve the last acknowledged batch', async () => {
  const f = fixture();
  try {
    await f.checker.check();
    await f.checker.acknowledge([item().source_id]);
    f.response(JSON.stringify({ ok: true, items: [], next: { last_ts: '12', followed: { 'C123:10': { last_seen: '11' } } } }));
    assert.deepEqual(await f.checker.check(), { status: 'quiet', followed_threads: 1 });
    assert.deepEqual(f.state().followed, { 'C123:10': { last_seen: '11' } });
    await new SlackChecker(f.options, f.browser).acknowledge([item().source_id]);
  } finally { f.close(); }
});

test('concurrent checker instances replay one pending batch instead of running Chrome twice', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.checker.check(), new SlackChecker(f.options, f.browser).check()]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(f.calls.length, 1);
  } finally { f.close(); }
});

test('missing tab, timeout, malformed state, and Slack API failures stay visible and never become quiet', async () => {
  const f = fixture();
  try {
    for (const response of ['NO_SLACK_TAB', 'CHROME_TAB_EXECUTION_FAILED', new Error('Chrome automation timed out'),
      'not JSON', JSON.stringify({ ok: false, error: 'conversations.replies:ratelimited' }),
      JSON.stringify({ ok: true, items: [item()], next: { last_ts: 'bad', followed: {} } })]) {
      f.response(response);
      assert.equal((await f.checker.check()).status, 'error');
      assert.throws(f.state, /ENOENT/);
    }
    writeFileSync(path.join(f.root, 'followed-threads.json'), '{"broken":{}}');
    const result = await f.checker.check();
    assert.equal(result.status, 'error');
  } finally { f.close(); }
});

test('recovery is explicit; other tabs are tried without mutating windows', async () => {
  const f = fixture();
  try {
    f.response('NO_SLACK_TAB');
    await f.checker.check();
    await f.checker.recover('try_other_tabs');
    assert.deepEqual(f.calls.map(call => call.selection), ['first', 'others']);
    assert.deepEqual(f.recoveries, []);
    await f.checker.recover('open_slack');
    assert.deepEqual(f.recoveries, ['open_slack']);
    assert.equal(f.calls.at(-1)!.selection, 'first');
  } finally { f.close(); }
});

type ApiResponse = Record<string, unknown>;
function runBrowserScript(f: ReturnType<typeof fixture>, api: (method: string, params: URLSearchParams) => ApiResponse,
  state = { last_ts: '10', followed: {} }): Record<string, unknown> {
  class Xhr {
    status = 200;
    responseText = '';
    method = '';
    open(_verb: string, url: string, async: boolean) { assert.equal(async, false); this.method = url.split('/').at(-1)!; }
    setRequestHeader() {}
    send(body: string) {
      const params = new URLSearchParams(body);
      assert.equal(params.get('token'), 'private-session-token');
      this.responseText = JSON.stringify(api(this.method, params));
    }
  }
  const source = slackCheckScript(f.options, state);
  const raw = vm.runInNewContext(source, {
    localStorage: { getItem: () => JSON.stringify({ teams: { T123: { token: 'private-session-token' } } }) },
    XMLHttpRequest: Xhr, Date: { now: () => 1_000_000 },
  });
  assert.equal(raw.includes('private-session-token'), false);
  return JSON.parse(raw);
}

test('browser check validates workspace and account before reading Slack', () => {
  const f = fixture();
  try {
    const methods: string[] = [];
    const result = runBrowserScript(f, method => {
      methods.push(method);
      return { ok: true, team_id: 'TOTHER', user_id: 'U123' };
    });
    assert.deepEqual(result, { ok: false, error: 'slack_session_identity_mismatch' });
    assert.deepEqual(methods, ['auth.test']);
  } finally { f.close(); }
});

test('browser finds mentions and paginated replies, deduplicates, and resolves names without exposing credentials', () => {
  const f = fixture();
  try {
    const result = runBrowserScript(f, (method, params) => {
      if (method === 'auth.test') return { ok: true, team_id: 'T123', user_id: 'U123' };
      if (method === 'search.messages') return { ok: true, messages: { matches: params.get('query')!.startsWith('from:') ? [] : [
        { ts: '12', user: 'U456', channel: { id: 'C123', name: 'general' }, text: 'hello', permalink: 'https://slack.example/mention' },
      ] } };
      if (method === 'conversations.replies') return params.get('cursor') ? { ok: true, messages: [
        { ts: '14', user: 'U456', text: 'second reply' },
      ] } : { ok: true, messages: [
        { ts: '12', user: 'U456', text: 'hello' }, { ts: '13', user: 'U456', text: 'first reply' },
      ], response_metadata: { next_cursor: 'next' }, has_more: true };
      if (method === 'chat.getPermalink') return { ok: true, permalink: `https://slack.example/${params.get('message_ts')}` };
      if (method === 'users.info') return { ok: true, user: { profile: { display_name: 'Verified name' } } };
      throw new Error(`Unexpected method ${method}`);
    });
    assert.equal(result.ok, true);
    const items = result.items as SlackActivity[];
    assert.deepEqual(items.map(value => value.source_id), ['slack:T123:C123:12', 'slack:T123:C123:13', 'slack:T123:C123:14']);
    assert.deepEqual(items.map(value => value.kind), ['mention', 'reply', 'reply']);
    assert.equal(items[2].author_name, 'Verified name');
    assert.deepEqual(result.next, { last_ts: '12', followed: { 'C123:12': { last_seen: '14', added: 1000, channel: 'C123', name: 'general' } } });
  } finally { f.close(); }
});

test('browser API errors and incomplete pagination return errors rather than partial findings', () => {
  const f = fixture();
  try {
    const broken = runBrowserScript(f, method => method === 'auth.test'
      ? { ok: true, team_id: 'T123', user_id: 'U123' } : { ok: false, error: 'ratelimited' });
    assert.deepEqual(broken, { ok: false, error: 'search.messages:ratelimited' });
    let pages = 0;
    const limited = runBrowserScript(f, method => {
      if (method === 'auth.test') return { ok: true, team_id: 'T123', user_id: 'U123' };
      pages++;
      return { ok: true, messages: { matches: Array.from({ length: 100 }, () => ({ ts: '12' })) } };
    });
    assert.deepEqual(limited, { ok: false, error: 'search.messages:pagination_limit' });
    assert.equal(pages, 10);
  } finally { f.close(); }
});

test('short search pages follow authoritative pagination before advancing the mention watermark', () => {
  const f = fixture();
  try {
    for (const pagination of ['pagination', 'paging']) {
      const pages: number[] = [];
      const result = runBrowserScript(f, (method, params) => {
        if (method === 'auth.test') return { ok: true, team_id: 'T123', user_id: 'U123' };
        if (method === 'search.messages') {
          if (params.get('query')!.startsWith('from:')) return { ok: true, messages: { matches: [] } };
          const page = Number(params.get('page'));
          pages.push(page);
          return { ok: true, messages: { matches: [{ ts: page === 1 ? '200' : '150', user: 'U456',
            channel: { id: 'C123' }, text: 'mention', thread_ts: '120' }],
          [pagination]: pagination === 'pagination' ? { page_count: 2 } : { pages: 2 } } };
        }
        if (method === 'conversations.replies') return { ok: true, messages: [] };
        if (method === 'users.info') return { ok: true, user: { name: 'someone' } };
        throw new Error(`Unexpected method ${method}`);
      }, { last_ts: '100', followed: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(pages, [1, 2]);
      assert.deepEqual((result.items as SlackActivity[]).map(value => value.ts), ['150', '200']);
    }
  } finally { f.close(); }
});

test('new threads discovered from own posts start now; existing followed positions remain intact', () => {
  const f = fixture();
  try {
    const baselines: Record<string, string> = {};
    const result = runBrowserScript(f, (method, params) => {
      if (method === 'auth.test') return { ok: true, team_id: 'T123', user_id: 'U123' };
      if (method === 'search.messages') return { ok: true, messages: { matches: params.get('query')!.startsWith('from:') ? [
        { ts: '200', user: 'U123', channel: { id: 'C123' }, thread_ts: '100' },
        { ts: '150', user: 'U123', channel: { id: 'C123' }, thread_ts: '50' },
      ] : [] } };
      if (method === 'conversations.replies') {
        baselines[params.get('ts')!] = params.get('oldest')!;
        return { ok: true, messages: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    }, { last_ts: '10', followed: { 'C123:50': { last_seen: '160' } } });
    assert.equal(result.ok, true);
    assert.deepEqual(baselines, { '50': '160', '100': '1000' });
    assert.deepEqual(result.items, []);
  } finally { f.close(); }
});

test('Chrome automation targets explicit Chrome background tabs and cannot mistake frontmost for oldest', async () => {
  const scripts: string[] = [];
  const browser = new ChromeSlackBrowser('https://app.slack.com/client/T123', async script => {
    scripts.push(script);
    return script.includes('return id of every window') ? '20, 10' : 'NO_SLACK_TAB';
  });
  await browser.evaluate('test-script', 'first');
  await browser.evaluate('test-script', 'others');
  assert.ok(scripts.every(script => script.includes('application id "com.google.Chrome"')));
  assert.ok(scripts.every(script => !/activate|Comet|default browser/.test(script)));
  assert.ok(scripts.some(script => script.includes('matchCount > 1')));
  assert.ok(scripts.some(script => script.includes('if lastResult starts with "{\\"ok\\":true,"')));
  await assert.rejects(browser.recover('keep_first_window'), /oldest.*unknown/);
  assert.equal(scripts.some(script => script.includes('close w')), false);
});

test('Chrome keeps a known sole original window when newer windows appear; fallback reopens Chrome only', async () => {
  const scripts: string[] = [];
  let windows = '10';
  const browser = new ChromeSlackBrowser('https://app.slack.com/client/T123', async script => {
    scripts.push(script);
    return script.includes('return id of every window') ? windows : 'NO_SLACK_TAB';
  });
  await browser.evaluate('test', 'first');
  windows = '20, 10';
  await browser.recover('keep_first_window');
  assert.ok(scripts.some(script => script.includes('if id of w is not 10 then close w')));
  await browser.recover('reopen_window');
  await browser.recover('open_slack');
  assert.ok(scripts.some(script => script.includes('close every window\n  make new window')));
  assert.ok(scripts.some(script => script.includes('URL:"https://app.slack.com/client/T123"')));
});
