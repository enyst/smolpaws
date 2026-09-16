import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startConversationRequestSchema, type StoredConversation } from '../../../packages/openhands-agent-server/src/models.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { loadModelSelections, productProfileSelection, selectRoleProfile } from './models.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'smolpaws-models-'));
  const configPath = path.join(root, 'models.json');
  const scheduler = new TaskScheduler(path.join(root, 'scheduler.db'));
  const id = '10000000-0000-4000-8000-000000000001';
  const request = startConversationRequestSchema.parse({ id, workspace: { working_dir: root } });
  const stored: StoredConversation = { id, request, workspace: request.workspace, title: null,
    tags: { scope: 'main', ingress: 'whatsapp' }, secret_names: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const register = (platform: string, scopeId: string) => scheduler.register({ conversationId: id, scopeId, workingDir: root,
    relayDbPath: path.join(root, 'relay.db'), defaults: {},
    lane: { laneKey: `${platform}:${id}`, platform, chatId: id, accountId: null, threadId: null } });
  return { root, configPath, scheduler, stored, register,
    write: (value: unknown) => writeFileSync(configPath, JSON.stringify(value)),
    close: () => { scheduler.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('named role selections use exact scope overrides and do not borrow the agent profile', async () => {
  const f = fixture();
  try {
    f.write({ version: 1, roles: { agent: 'shared', condenser: 'small' },
      scopes: { 'whatsapp:main': { agent: 'main-profile', oracle: 'consult' }, 'slack:paws': { agent: 'slack-profile' } } });
    const config = await loadModelSelections({ configPath: f.configPath });
    assert.equal(selectRoleProfile(config, 'agent', 'whatsapp:main'), 'main-profile');
    assert.equal(selectRoleProfile(config, 'agent', 'slack:paws'), 'slack-profile');
    assert.equal(selectRoleProfile(config, 'agent', 'whatsapp:hunting'), 'shared');
    assert.equal(selectRoleProfile(config, 'condenser', 'whatsapp:main'), 'small');
    assert.equal(selectRoleProfile(config, 'oracle', 'whatsapp:main'), 'consult');
    assert.equal(selectRoleProfile(config, 'oracle', 'slack:paws'), undefined);
    assert.equal(selectRoleProfile(config, 'unknown', 'whatsapp:main'), undefined);
  } finally { f.close(); }
});

test('product uses trusted lane identity, reloads edits, and ignores forged request tags', async () => {
  const f = fixture();
  try {
    const select = productProfileSelection(f.scheduler, { configPath: f.configPath });
    f.write({ version: 1, scopes: { 'whatsapp:main': { agent: 'first' } } });
    await assert.rejects(async () => select({ stored: f.stored }), /registered scheduler lane/);
    f.register('whatsapp', 'main');
    assert.equal(await select({ stored: f.stored }), 'first');
    f.write({ version: 1, scopes: { 'whatsapp:main': { agent: 'second' } } });
    assert.equal(await select({ stored: f.stored }), 'second');
    f.register('slack', 'main');
    assert.equal(await select({ stored: f.stored }), undefined);
  } finally { f.close(); }
});

test('absent implicit config preserves existing selection; explicit missing config is an error', async () => {
  const f = fixture();
  const previous = process.env.SMOLPAWS_MODELS_CONFIG;
  delete process.env.SMOLPAWS_MODELS_CONFIG;
  try {
    assert.equal(selectRoleProfile(await loadModelSelections({ homeDir: f.root }), 'agent', 'whatsapp:main'), undefined);
    await assert.rejects(() => loadModelSelections({ configPath: f.configPath }), /ENOENT/);
    f.write({ version: 1 });
    process.env.SMOLPAWS_MODELS_CONFIG = f.configPath;
    assert.deepEqual(await loadModelSelections(), { version: 1 });
    const override = path.join(f.root, 'override.json');
    writeFileSync(override, JSON.stringify({ version: 1, roles: { agent: 'override' } }));
    assert.equal(selectRoleProfile(await loadModelSelections({ configPath: override }), 'agent'), 'override');
  } finally {
    if (previous === undefined) delete process.env.SMOLPAWS_MODELS_CONFIG;
    else process.env.SMOLPAWS_MODELS_CONFIG = previous;
    f.close();
  }
});

test('invalid config fails clearly and never accepts inline provider settings or credentials', async () => {
  const f = fixture();
  try {
    for (const config of [null, [], { version: 2 }, { version: 1, typo: {} },
      { version: 1, roles: { agent: { model: 'raw', apiKey: 'secret' } } },
      { version: 1, roles: { agent: '' } }, { version: 1, roles: { agent: ' spaced ' } },
      { version: 1, roles: { 'bad role': 'profile' } },
      { version: 1, scopes: [] }, { version: 1, scopes: { '*': { agent: 'profile' } } },
      { version: 1, scopes: { 'whatsapp:main': { agent: null } } }]) {
      f.write(config);
      await assert.rejects(() => loadModelSelections({ configPath: f.configPath }), /Invalid SmolPaws model configuration/);
    }
    writeFileSync(f.configPath, '{"version":1,"secret":"do-not-echo"');
    await assert.rejects(() => loadModelSelections({ configPath: f.configPath }), error =>
      error instanceof Error && error.message === 'Invalid SmolPaws model configuration');
  } finally { f.close(); }
});
