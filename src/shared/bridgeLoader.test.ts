import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverBridges, checkReadiness, type PluginManifest } from './bridgeLoader.js';

function createTmpAppsDir(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-loader-test-'));
  return tmp;
}

// ── discoverBridges ────────────────────────────────────────────────────

test('discoverBridges finds bridge manifests in apps/', async () => {
  const appsDir = createTmpAppsDir();
  try {
    const discordDir = path.join(appsDir, 'discord');
    mkdirSync(discordDir);
    writeFileSync(
      path.join(discordDir, 'plugin.json'),
      JSON.stringify({
        name: 'discord',
        label: 'Discord',
        kind: 'bridge',
        version: '1.0.0',
        requiredEnv: ['DISCORD_BOT_TOKEN'],
      }),
    );

    const bridges = await discoverBridges(appsDir);
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0].name, 'discord');
    assert.equal(bridges[0].label, 'Discord');
    assert.equal(bridges[0].dir, discordDir);
    assert.deepEqual(bridges[0].manifest.requiredEnv, ['DISCORD_BOT_TOKEN']);
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('discoverBridges skips non-bridge manifests', async () => {
  const appsDir = createTmpAppsDir();
  try {
    const toolDir = path.join(appsDir, 'some-tool');
    mkdirSync(toolDir);
    writeFileSync(
      path.join(toolDir, 'plugin.json'),
      JSON.stringify({ name: 'tool', label: 'Tool', kind: 'tool', version: '1.0.0' }),
    );

    const bridges = await discoverBridges(appsDir);
    assert.equal(bridges.length, 0);
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('discoverBridges skips directories without plugin.json', async () => {
  const appsDir = createTmpAppsDir();
  try {
    mkdirSync(path.join(appsDir, 'agent-server'));
    const bridges = await discoverBridges(appsDir);
    assert.equal(bridges.length, 0);
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('discoverBridges skips malformed JSON', async () => {
  const appsDir = createTmpAppsDir();
  try {
    const badDir = path.join(appsDir, 'bad');
    mkdirSync(badDir);
    writeFileSync(path.join(badDir, 'plugin.json'), '{ broken json');

    const bridges = await discoverBridges(appsDir);
    assert.equal(bridges.length, 0);
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('discoverBridges returns empty for nonexistent directory', async () => {
  const bridges = await discoverBridges('/tmp/nonexistent-bridge-test-dir');
  assert.equal(bridges.length, 0);
});

test('discoverBridges sorts results by name', async () => {
  const appsDir = createTmpAppsDir();
  try {
    for (const name of ['slack', 'discord', 'telegram']) {
      const dir = path.join(appsDir, name);
      mkdirSync(dir);
      writeFileSync(
        path.join(dir, 'plugin.json'),
        JSON.stringify({ name, label: name, kind: 'bridge', version: '1.0.0' }),
      );
    }

    const bridges = await discoverBridges(appsDir);
    assert.deepEqual(
      bridges.map((b) => b.name),
      ['discord', 'slack', 'telegram'],
    );
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

// ── checkReadiness ─────────────────────────────────────────────────────

test('checkReadiness returns ready when all required env vars present', () => {
  const manifest: PluginManifest = {
    name: 'test',
    label: 'Test',
    kind: 'bridge',
    version: '1.0.0',
    requiredEnv: ['FOO', 'BAR'],
  };
  const result = checkReadiness(manifest, { FOO: 'x', BAR: 'y' });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});

test('checkReadiness reports missing env vars', () => {
  const manifest: PluginManifest = {
    name: 'test',
    label: 'Test',
    kind: 'bridge',
    version: '1.0.0',
    requiredEnv: ['FOO', 'BAR', 'BAZ'],
  };
  const result = checkReadiness(manifest, { FOO: 'x' });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['BAR', 'BAZ']);
});

test('checkReadiness treats empty strings as missing', () => {
  const manifest: PluginManifest = {
    name: 'test',
    label: 'Test',
    kind: 'bridge',
    version: '1.0.0',
    requiredEnv: ['TOKEN'],
  };
  const result = checkReadiness(manifest, { TOKEN: '  ' });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['TOKEN']);
});

test('checkReadiness returns ready when no requiredEnv defined', () => {
  const manifest: PluginManifest = {
    name: 'test',
    label: 'Test',
    kind: 'bridge',
    version: '1.0.0',
  };
  const result = checkReadiness(manifest, {});
  assert.equal(result.ready, true);
  assert.deepEqual(result.missing, []);
});
