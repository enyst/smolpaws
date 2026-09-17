import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startConversationRequestSchema, type StoredConversation } from '../../../packages/openhands-agent-server/src/models.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { productContext } from './context.js';

const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'product-context-'));
  const scheduler = new TaskScheduler(path.join(root, 'scheduler.db'));
  const configPath = path.join(root, 'context.json');
  function conversation(id: string, scopeId = 'main', platform = 'whatsapp'): StoredConversation {
    const request = startConversationRequestSchema.parse({ id, persistence_dir: path.join(root, 'conversations'), workspace: { working_dir: root } });
    scheduler.register({ conversationId: id, scopeId, workingDir: root, relayDbPath: path.join(root, 'relay.db'), defaults: {},
      lane: { laneKey: `${platform}:${id}`, platform, chatId: id, accountId: null, threadId: null } });
    return { id, request, workspace: request.workspace, title: null, tags: { scope: 'main', ingress: 'whatsapp' }, secret_names: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  }
  const write = (name: string, content: string): string => { const file = path.join(root, name); writeFileSync(file, content); return file; };
  return { root, scheduler, configPath, conversation, write,
    config: (value: unknown) => writeFileSync(configPath, JSON.stringify(value)),
    snapshot: (id: string) => path.join(root, 'conversations', id, 'smolpaws-context.json'),
    close: () => { scheduler.close(); rmSync(root, { recursive: true, force: true }); } };
}
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];

test('full large context body becomes unconditional repo context and a private hashed snapshot', async () => {
  const f = fixture();
  try {
    const content = `  start\n${'full-context '.repeat(5000)}\nend  \n`;
    const source = f.write('MEMORY.md', content);
    f.config({ version: 1, files: ['MEMORY.md'] });
    const stored = f.conversation(ids[0]!);
    const context = await productContext(f.scheduler, { configPath: f.configPath })(null, { stored });
    assert.equal(context!.skills.length, 1);
    assert.equal(context!.skills[0]!.content, content);
    assert.equal(context!.skills[0]!.trigger, null);
    assert.equal(context!.skills[0]!.isAgentskillsFormat, false);
    assert.equal(context!.partitionSkills().repoSkills.length, 1);
    // SDK repo-context rendering trims outer whitespace; it does not truncate the body.
    assert.ok(context!.getSystemMessageSuffix()!.includes(content.trim()));
    const snapshot = JSON.parse(readFileSync(f.snapshot(stored.id), 'utf8'));
    assert.equal(snapshot.files[0].content, content);
    assert.equal(snapshot.files[0].path, realpathSync(source));
    assert.equal(snapshot.scope, 'whatsapp:main');
    assert.equal(snapshot.files[0].sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(statSync(f.snapshot(stored.id)).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test('trusted scheduler scope selects private files; HTTP tags cannot grant Main context', async () => {
  const f = fixture();
  try {
    f.write('public.md', 'shared'); f.write('private.md', 'private Main memory');
    f.config({ version: 1, files: ['public.md'], scopes: { 'whatsapp:main': ['private.md'] } });
    const configure = productContext(f.scheduler, { configPath: f.configPath });
    const main = await configure(null, { stored: f.conversation(ids[0]!) });
    const other = f.conversation(ids[1]!, 'agent-server:isolated', 'agent-server');
    const native = await configure(null, { stored: other });
    assert.deepEqual(main!.skills.map(skill => skill.content), ['shared', 'private Main memory']);
    assert.deepEqual(native!.skills.map(skill => skill.content), ['shared']);
    assert.equal(native!.systemMessageSuffix, null);
    assert.equal(JSON.parse(readFileSync(f.snapshot(other.id), 'utf8')).scope, 'agent-server:agent-server:isolated');
  } finally { f.close(); }
});

test('canonical paths deduplicate common and scoped files while keeping same-basename files distinct', async () => {
  const f = fixture();
  try {
    const file = f.write('memory.md', 'first');
    symlinkSync(file, path.join(f.root, 'alias.md'));
    mkdirSync(path.join(f.root, 'other')); f.write('other/memory.md', 'second');
    f.config({ version: 1, files: ['memory.md', './memory.md', 'alias.md'], scopes: { 'whatsapp:main': [file, 'other/memory.md'] } });
    const context = await productContext(f.scheduler, { configPath: f.configPath })(null, { stored: f.conversation(ids[0]!) });
    assert.deepEqual(context!.skills.map(skill => skill.content), ['first', 'second']);
    assert.equal(new Set(context!.skills.map(skill => skill.name)).size, 2);
  } finally { f.close(); }
});

test('restart reuses the published snapshot despite changed or deleted config and source files', async () => {
  const f = fixture();
  let reopened: TaskScheduler | undefined;
  try {
    const source = f.write('memory.md', 'original'); f.config({ version: 1, files: ['memory.md'] });
    const stored = f.conversation(ids[0]!);
    await productContext(f.scheduler, { configPath: f.configPath })(null, { stored });
    const before = readFileSync(f.snapshot(stored.id), 'utf8');
    writeFileSync(source, 'changed'); f.config({ version: 1, files: [] });
    reopened = new TaskScheduler(path.join(f.root, 'scheduler.db'));
    const configure = productContext(reopened, { configPath: f.configPath });
    assert.equal((await configure(null, { stored }))!.skills[0]!.content, 'original');
    rmSync(source); rmSync(f.configPath);
    assert.equal((await configure(null, { stored }))!.skills[0]!.content, 'original');
    assert.equal(readFileSync(f.snapshot(stored.id), 'utf8'), before);
  } finally { reopened?.close(); f.close(); }
});

test('missing explicit config/files and corrupt snapshots fail instead of silently falling back', async () => {
  const f = fixture();
  try {
    const stored = f.conversation(ids[0]!);
    const configure = productContext(f.scheduler, { configPath: f.configPath });
    await assert.rejects(async () => configure(null, { stored }), /ENOENT/);
    f.config({ version: 1, files: ['missing.md'] });
    await assert.rejects(async () => configure(null, { stored }), /ENOENT/);
    f.config({ version: 1, files: [f.root] });
    await assert.rejects(async () => configure(null, { stored }), /not a file/);
    f.config({ version: 1, files: [] });
    await configure(null, { stored });
    writeFileSync(f.snapshot(stored.id), '{broken');
    await assert.rejects(async () => configure(null, { stored }), SyntaxError);
    writeFileSync(f.snapshot(stored.id), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), scope: 'whatsapp:main', files: [{ path: '/file.md', name: 'file', sha256: 'wrong', content: 'tampered' }] }));
    await assert.rejects(async () => configure(null, { stored }), /snapshot file/);
  } finally { f.close(); }
});

test('implicit missing config and omitted files use identity defaults; an empty files list opts out', async () => {
  const f = fixture();
  const previous = process.env.SMOLPAWS_CONTEXT_CONFIG;
  delete process.env.SMOLPAWS_CONTEXT_CONFIG;
  try {
    mkdirSync(path.join(f.root, 'docs', 'smolpaws'), { recursive: true });
    f.write('docs/smolpaws/SOUL.md', 'identity'); f.write('docs/smolpaws/HEARTBEAT.md', 'not startup context');
    const configure = productContext(f.scheduler, { homeDir: f.root, repoRoot: f.root });
    const first = await configure(null, { stored: f.conversation(ids[0]!) });
    assert.deepEqual(first!.skills.map(skill => skill.content), ['identity']);
    f.config({ version: 1, scopes: { 'whatsapp:main': [] } });
    assert.deepEqual((await configure(null, { stored: f.conversation(ids[1]!) }))!.skills.map(skill => skill.content), ['identity']);
    f.config({ version: 1, files: [] });
    assert.deepEqual((await configure(null, { stored: f.conversation('10000000-0000-4000-8000-000000000003') }))!.skills, []);
  } finally {
    if (previous === undefined) delete process.env.SMOLPAWS_CONTEXT_CONFIG; else process.env.SMOLPAWS_CONTEXT_CONFIG = previous;
    f.close();
  }
});

test('explicit option overrides environment config; environment files resolve relative and home paths', async () => {
  const f = fixture();
  const previous = process.env.SMOLPAWS_CONTEXT_CONFIG;
  try {
    const source = f.write('memory.md', 'environment context');
    const alternate = f.write('alternate.json', JSON.stringify({ version: 1, files: [] }));
    f.config({ version: 1, files: ['memory.md', `~/${path.relative(homedir(), source)}`] });
    process.env.SMOLPAWS_CONTEXT_CONFIG = f.configPath;
    assert.deepEqual((await productContext(f.scheduler, { configPath: alternate })(null, { stored: f.conversation(ids[0]!) }))!.skills, []);
    const context = await productContext(f.scheduler)(null, { stored: f.conversation(ids[1]!) });
    assert.deepEqual(context!.skills.map(skill => skill.content), ['environment context']);
    process.env.SMOLPAWS_CONTEXT_CONFIG = path.join(f.root, 'missing.json');
    await assert.rejects(async () => productContext(f.scheduler)(null, { stored: f.conversation('10000000-0000-4000-8000-000000000003') }), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.SMOLPAWS_CONTEXT_CONFIG; else process.env.SMOLPAWS_CONTEXT_CONFIG = previous;
    f.close();
  }
});

test('replacing the whole legacy suffix preserves every base field and leaves embedded examples alone', async () => {
  const f = fixture();
  try {
    f.write('memory.md', 'current memory'); f.config({ version: 1, files: ['memory.md'] });
    const baseSkill = sdk.skillSchema.parse({ name: 'base', content: 'base skill' });
    const base = new sdk.AgentContext({ skills: [baseSkill], systemMessageSuffix: '\n<SMOLPAWS_CONTEXT>old memory</SMOLPAWS_CONTEXT>\n',
      userMessageSuffix: 'user suffix', secrets: { TOKEN: { description: 'token purpose' } }, currentDatetime: '2026-09-16T12:00:00Z' });
    const context = await productContext(f.scheduler, { configPath: f.configPath })(base, { stored: f.conversation(ids[0]!) });
    assert.equal(context!.skills[0], baseSkill);
    assert.equal(context!.skills[1]!.content, 'current memory');
    assert.equal(context!.userMessageSuffix, base.userMessageSuffix);
    assert.deepEqual(context!.secrets, base.secrets);
    assert.equal(context!.currentDatetime, base.currentDatetime);
    assert.equal(context!.systemMessageSuffix, 'This conversation arrived through the whatsapp bridge. Replies are delivered back to that channel.');
    assert.ok(!context!.getSystemMessageSuffix()!.includes('old memory'));
    const unrelated = new sdk.AgentContext({ systemMessageSuffix: 'before\n<SMOLPAWS_CONTEXT>literal example</SMOLPAWS_CONTEXT>\nafter' });
    const preserved = await productContext(f.scheduler, { configPath: f.configPath })(unrelated, { stored: f.conversation(ids[1]!) });
    assert.equal(preserved!.systemMessageSuffix, `This conversation arrived through the whatsapp bridge. Replies are delivered back to that channel.\n\n${unrelated.systemMessageSuffix}`);
  } finally { f.close(); }
});

test('concurrent first use publishes one complete snapshot that both callers receive', async () => {
  const f = fixture();
  try {
    f.write('memory.md', 'stable memory'); f.config({ version: 1, files: ['memory.md'] });
    const stored = f.conversation(ids[0]!);
    const configure = productContext(f.scheduler, { configPath: f.configPath });
    const contexts = await Promise.all([configure(null, { stored }), configure(null, { stored })]);
    assert.deepEqual(contexts[0]!.skills, contexts[1]!.skills);
    assert.equal(JSON.parse(readFileSync(f.snapshot(stored.id), 'utf8')).files.length, 1);
  } finally { f.close(); }
});

test('configured isolated runs replace inherited files while ordinary and forged conversations keep normal context', async () => {
  const f = fixture();
  try {
    f.write('identity.md', 'full identity'); f.write('MEMORY.md', 'private scope memory'); f.write('checker.md', 'small checker role');
    f.config({ version: 1, files: ['identity.md'], scopes: { 'whatsapp:openhands': ['MEMORY.md'] } });
    const owner = f.conversation(ids[0]!, 'openhands');
    const created = f.scheduler.execute(owner.id, 'schedule_task', { prompt: 'check Slack', context_mode: 'isolated',
      schedule_type: 'once', schedule_value: new Date(0).toISOString() }, 'checker');
    const taskId = JSON.parse(created.text).task_id;
    const [run] = f.scheduler.due('whatsapp');
    const checker = f.conversation(run!.conversation_id, 'openhands');
    const scheduledConfig = f.write('scheduled-agents.json', JSON.stringify({ version: 1, tasks: {
      [taskId]: { profile: 'deepseek-v4-flash', context_files: ['checker.md'], tools: ['finish'] },
    } }));
    const configure = productContext(f.scheduler, { configPath: f.configPath, scheduledAgents: { configPath: scheduledConfig } });
    assert.deepEqual((await configure(null, { stored: checker }))!.skills.map(skill => skill.content), ['small checker role']);
    assert.deepEqual((await configure(null, { stored: owner }))!.skills.map(skill => skill.content), ['full identity', 'private scope memory']);
    const forged = f.conversation(ids[1]!, 'openhands');
    forged.tags = { scope: 'openhands', scheduled_task: taskId, ingress: 'whatsapp' };
    const lane = f.scheduler.lane(forged.id)!;
    f.scheduler.register({ ...lane, lane: { ...lane.lane, laneKey: `whatsapp:openhands:scheduled:${run!.id}` } });
    assert.deepEqual((await configure(null, { stored: forged }))!.skills.map(skill => skill.content), ['full identity', 'private scope memory']);
    const native = f.conversation('10000000-0000-4000-8000-000000000004', 'openhands', 'agent-server');
    native.tags = { scheduled_task: taskId };
    assert.deepEqual((await configure(null, { stored: native }))!.skills.map(skill => skill.content), ['full identity']);

    // Per-task replacement is still a first-use snapshot: editing either config cannot rewrite its history.
    f.write('checker.md', 'changed role');
    writeFileSync(scheduledConfig, JSON.stringify({ version: 1, tasks: {} }));
    assert.deepEqual((await configure(null, { stored: checker }))!.skills.map(skill => skill.content), ['small checker role']);
    rmSync(scheduledConfig); rmSync(f.configPath); rmSync(path.join(f.root, 'checker.md'));
    assert.deepEqual((await configure(null, { stored: checker }))!.skills.map(skill => skill.content), ['small checker role']);
  } finally { f.close(); }
});

test('a configured empty task file list replaces defaults without loading the general context config', async () => {
  const f = fixture();
  try {
    const owner = f.conversation(ids[0]!);
    const created = f.scheduler.execute(owner.id, 'schedule_task', { prompt: 'tiny task', context_mode: 'isolated',
      schedule_type: 'once', schedule_value: new Date(0).toISOString() }, 'tiny');
    const taskId = JSON.parse(created.text).task_id;
    const [run] = f.scheduler.due('whatsapp');
    const stored = f.conversation(run!.conversation_id);
    const scheduledConfig = f.write('scheduled-agents.json', JSON.stringify({ version: 1, tasks: {
      [taskId]: { profile: 'deepseek-v4-flash', context_files: [], tools: ['finish'] },
    } }));
    const context = await productContext(f.scheduler, { configPath: f.configPath, scheduledAgents: { configPath: scheduledConfig } })(null, { stored });
    assert.deepEqual(context!.skills, []);
    await assert.rejects(async () => productContext(f.scheduler, { configPath: f.configPath })(null, { stored: owner }), /ENOENT/);
  } finally { f.close(); }
});
