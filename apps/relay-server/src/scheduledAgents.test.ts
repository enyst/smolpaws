import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { loadScheduledAgent } from './scheduledAgents.js';

const entry = { profile: 'deepseek-v4-flash', context_files: ['checker.md'], tools: ['terminal', 'finish'] };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'scheduled-agents-'));
  const scheduler = new TaskScheduler(':memory:', () => 1000);
  const configPath = path.join(root, 'scheduled-agents.json');
  const lane = (id: string, platform = 'whatsapp', laneKey = `${platform}:${id}`) => scheduler.register({
    conversationId: id, scopeId: 'openhands', workingDir: root, relayDbPath: path.join(root, 'relay.db'),
    defaults: { tags: { scheduled_task: 'spoofed' } },
    lane: { laneKey, platform, chatId: 'openhands', accountId: null, threadId: null },
  });
  lane('owner');
  function schedule(context_mode = 'isolated', owner = 'owner', commandId = context_mode): string {
    const created = scheduler.execute(owner, 'schedule_task', { prompt: 'check', context_mode,
      schedule_type: 'once', schedule_value: new Date(1000).toISOString() }, commandId);
    assert.equal(created.is_error, false);
    return JSON.parse(created.text).task_id as string;
  }
  const taskId = schedule();
  const conversationId = scheduler.due('whatsapp')[0]!.conversation_id;
  return { root, configPath, scheduler, lane, schedule, taskId, conversationId,
    write: (tasks: unknown) => writeFileSync(configPath, JSON.stringify({ version: 1, tasks })),
    load: () => loadScheduledAgent(conversationId, scheduler, { configPath }),
    close: () => { scheduler.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('only the configured task’s trusted isolated runs select an agent specialization', () => {
  const f = fixture();
  try {
    const groupTask = f.schedule('group');
    f.lane('native', 'agent-server');
    const nativeTask = f.schedule('isolated', 'native');
    const nativeRun = f.scheduler.due('agent-server')[0]!;
    f.scheduler.due('whatsapp');
    const forged = `whatsapp:openhands:scheduled:${f.taskId}:1000`;
    f.lane('forged', 'whatsapp', forged);
    f.write({ [f.taskId]: entry, [groupTask]: { ...entry, profile: 'group-specialization-must-not-apply' } });
    assert.equal(f.load()!.profile, entry.profile);
    for (const id of ['owner', 'native', 'forged', 'unknown', nativeRun.conversation_id]) {
      assert.equal(loadScheduledAgent(id, f.scheduler, { configPath: f.configPath }), undefined, id);
    }
    assert.equal(f.scheduler.isolatedTask(nativeRun.conversation_id)!.id, nativeTask);
    assert.equal(f.scheduler.isolatedTask('owner'), undefined);
    f.scheduler.enqueued(f.scheduler.due('whatsapp').find(run => run.conversation_id === f.conversationId)!.id);
    assert.equal(f.load()!.profile, entry.profile, 'provenance survives dispatch');
  } finally { f.close(); }
});

test('paths resolve from the config directory, home paths expand, and edits are reloaded', () => {
  const f = fixture();
  try {
    f.write({ [f.taskId]: { ...entry, context_files: ['checker.md', '~/checker-role.md'],
      tools: ['check_slack', 'recover_slack', 'notify_smolpaws', 'terminal', 'finish'],
      slack: { workspace_id: 'T06P212QSEA', user_id: 'U123456', workspace_url: 'https://app.slack.com/client/T06P212QSEA', state_dir: './slack-state' } } });
    const config = f.load()!;
    assert.deepEqual(config.context_files, [path.join(f.root, 'checker.md'), path.join(homedir(), 'checker-role.md')]);
    assert.equal(config.slack!.state_dir, path.join(f.root, 'slack-state'));
    f.write({ [f.taskId]: { ...entry, profile: 'other-profile', context_files: [] } });
    assert.equal(f.load()!.profile, 'other-profile');
    assert.deepEqual(f.load()!.context_files, []);
  } finally { f.close(); }
});

test('implicit absent config does not change scheduled agents, while explicit missing config fails', () => {
  const f = fixture();
  const previous = process.env.SMOLPAWS_SCHEDULED_AGENTS_CONFIG;
  delete process.env.SMOLPAWS_SCHEDULED_AGENTS_CONFIG;
  try {
    assert.equal(loadScheduledAgent(f.conversationId, f.scheduler, { homeDir: f.root }), undefined);
    assert.throws(f.load, /ENOENT/);
    f.write({ [f.taskId]: entry });
    process.env.SMOLPAWS_SCHEDULED_AGENTS_CONFIG = f.configPath;
    assert.equal(loadScheduledAgent(f.conversationId, f.scheduler)!.profile, entry.profile);
    const alternate = path.join(f.root, 'other.json');
    writeFileSync(alternate, JSON.stringify({ version: 1, tasks: {} }));
    assert.equal(loadScheduledAgent(f.conversationId, f.scheduler, { configPath: alternate }), undefined);
  } finally {
    if (previous === undefined) delete process.env.SMOLPAWS_SCHEDULED_AGENTS_CONFIG;
    else process.env.SMOLPAWS_SCHEDULED_AGENTS_CONFIG = previous;
    f.close();
  }
});

test('unknown fields, invalid tools and inline model credentials fail without echoing source', () => {
  const f = fixture();
  try {
    for (const value of [null, [], { version: 2, tasks: {} }, { version: 1 }, { version: 1, tasks: [] },
      { version: 1, tasks: {}, typo: true }]) {
      writeFileSync(f.configPath, JSON.stringify(value));
      assert.throws(f.load, /Invalid SmolPaws scheduled agent configuration/);
    }
    for (const invalid of [null, [], {}, { ...entry, secret: 'no' }, { ...entry, profile: { api_key: 'secret' } },
      { ...entry, profile: '' }, { ...entry, profile: ' spaces ' }, { ...entry, context_files: [''] },
      { ...entry, tools: ['tool_typo'] }, { ...entry, tools: ['finish', 'finish'] },
      { ...entry, tools: ['check_slack'] }, { ...entry, slack: {} },
      { ...entry, slack: { workspace_id: 'T123', user_id: 'U123', workspace_url: 'https://other.example/', state_dir: 'state' } }]) {
      f.write({ [f.taskId]: invalid });
      assert.throws(f.load, /Invalid SmolPaws scheduled agent configuration/);
    }
    writeFileSync(f.configPath, '{"secret":"do-not-echo"');
    assert.throws(f.load, error => error instanceof Error && error.message === 'Invalid SmolPaws scheduled agent configuration');
    assert.equal(loadScheduledAgent('owner', f.scheduler, { configPath: f.configPath }), undefined,
      'bad task-only configuration cannot change regular conversation behavior');
  } finally { f.close(); }
});
