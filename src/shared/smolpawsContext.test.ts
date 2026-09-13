import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRelayConversationDefaults, resolveRelayWorkingDir } from './relayConversationDefaults.js';
import { loadSmolpawsContextDocs, renderSmolpawsContextSuffix, smolpawsRepoRoot } from './smolpawsContext.js';

function fakeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-context-'));
  mkdirSync(path.join(root, 'docs', 'smolpaws'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'smolpaws', 'SOUL.md'), '# SOUL\nbe a good cat\n');
  writeFileSync(path.join(root, 'docs', 'smolpaws', 'IDENTITY.md'), '# IDENTITY\nI am paws\n');
  writeFileSync(path.join(root, 'docs', 'smolpaws', 'HEARTBEAT.md'), '# HEARTBEAT\nnot for chat\n');
  writeFileSync(path.join(root, 'docs', 'smolpaws', 'README.md'), '# README\nnot for chat\n');
  writeFileSync(path.join(root, 'docs', 'smolpaws', 'notes.txt'), 'ignored\n');
  return root;
}

test('loads docs/smolpaws markdown in stable order and skips readme/heartbeat', () => {
  const root = fakeRepo();
  try {
    const docs = loadSmolpawsContextDocs({ repoRoot: root });
    assert.deepEqual(docs.map((doc) => doc.name), ['docs/smolpaws/IDENTITY.md', 'docs/smolpaws/SOUL.md']);
    assert.equal(docs[0]?.content, '# IDENTITY\nI am paws');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('appends existing extra files and ignores missing ones', () => {
  const root = fakeRepo();
  const memory = path.join(root, 'MEMORY.md');
  writeFileSync(memory, 'remember the fish\n');
  try {
    const docs = loadSmolpawsContextDocs({ repoRoot: root, extraFiles: [memory, path.join(root, 'nope.md')] });
    assert.deepEqual(docs.map((doc) => doc.name), ['docs/smolpaws/IDENTITY.md', 'docs/smolpaws/SOUL.md', 'MEMORY.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renders one suffix with the ingress header, or null when empty', () => {
  const root = fakeRepo();
  try {
    const suffix = renderSmolpawsContextSuffix(loadSmolpawsContextDocs({ repoRoot: root }), 'slack');
    assert.ok(suffix?.startsWith('<SMOLPAWS_CONTEXT>\nThis conversation arrived through the slack bridge.'));
    assert.ok(suffix?.includes('[BEGIN context from docs/smolpaws/SOUL.md]\n# SOUL\nbe a good cat\n[END context]'));
    assert.ok(suffix?.endsWith('</SMOLPAWS_CONTEXT>'));
    assert.equal(renderSmolpawsContextSuffix([], 'slack'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real checkout carries the canonical identity docs', () => {
  const docs = loadSmolpawsContextDocs({ repoRoot: smolpawsRepoRoot() });
  const names = docs.map((doc) => doc.name);
  assert.ok(names.includes('docs/smolpaws/SOUL.md'));
  assert.ok(names.includes('docs/smolpaws/IDENTITY.md'));
  assert.ok(!names.includes('docs/smolpaws/HEARTBEAT.md'));
});

test('resolves the working dir from explicit env, workspace root, then the checkout', () => {
  const root = fakeRepo();
  const explicit = path.join(root, 'explicit', 'dir');
  const workspaceRoot = path.join(root, 'repos');
  mkdirSync(path.join(workspaceRoot, 'smolpaws'), { recursive: true });
  try {
    assert.equal(resolveRelayWorkingDir({ SMOLPAWS_WORKING_DIR: explicit }, root), explicit);
    assert.equal(resolveRelayWorkingDir({ SMOLPAWS_WORKSPACE_ROOT: workspaceRoot }, root), path.join(workspaceRoot, 'smolpaws'));
    assert.equal(resolveRelayWorkingDir({ SMOLPAWS_WORKSPACE_ROOT: path.join(root, 'missing') }, root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('builds conversation defaults with workspace, ingress tag, and identity context', () => {
  const root = fakeRepo();
  try {
    const defaults = buildRelayConversationDefaults({ ingress: 'whatsapp', env: { SMOLPAWS_WORKSPACE_ROOT: path.join(root, 'missing') }, repoRoot: root });
    assert.deepEqual(defaults.workspace, { kind: 'LocalWorkspace', working_dir: root });
    assert.deepEqual(defaults.tags, { ingress: 'whatsapp' });
    const agent = defaults.agent as { agent_context: { system_message_suffix: string } };
    assert.ok(agent.agent_context.system_message_suffix.includes('I am paws'));
    const bare = buildRelayConversationDefaults({ ingress: 'whatsapp', env: {}, repoRoot: root, includeContext: false });
    assert.equal(bare.agent, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
