import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverBridges, checkReadiness, loadBridges, collectBridgeSecretEnv, type PluginManifest } from './bridgeLoader.js';
import { bridgeRegistry, BaseBridgeAdapter } from './bridgeAdapter.js';

function createTmpAppsDir(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-loader-test-'));
  return tmp;
}

/** Minimal logger that records calls for assertion. */
function createTestLogger() {
  const calls: { level: string; msg: string; obj?: Record<string, unknown> }[] = [];
  const log = (level: string) => (obj: unknown, msg?: string) => {
    if (typeof obj === 'string') {
      calls.push({ level, msg: obj });
    } else {
      calls.push({ level, msg: msg ?? '', obj: obj as Record<string, unknown> });
    }
  };
  const child = (bindings: Record<string, unknown>) => {
    // Return a child logger that tags calls with the bindings
    const childLogger = makeLogger();
    return childLogger;
  };
  const makeLogger = () => ({
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    silent: log('silent'),
    child,
    level: 'info',
  });
  return { logger: makeLogger() as any, calls };
}

/**
 * Create a fake bridge that's ready for loadBridges to start.
 *
 * Writes a no-op adapter.js (the dynamic import needs to succeed)
 * and pre-registers a trivial adapter factory in bridgeRegistry
 * (since temp .js files can't import .ts sources under tsx).
 *
 * This tests the real loadBridges flow: discovery → readiness →
 * registry check → startAdapter. The dynamic-import-triggers-
 * registration path is what Discord uses in production.
 */
function writeFakeAdapter(bridgeDir: string, name: string): void {
  const srcDir = path.join(bridgeDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, 'adapter.js'), `// no-op — registration done in test\n`);

  // Pre-register in the shared singleton
  bridgeRegistry.register(name, (config) => {
    return new (class extends BaseBridgeAdapter {
      protected async connect(): Promise<void> {}
      protected async disconnect(): Promise<void> {}
      async sendReply(): Promise<void> {}
    })(config);
  });
}

/**
 * Write a broken adapter module that throws on import.
 */
function writeBrokenAdapter(bridgeDir: string): void {
  const srcDir = path.join(bridgeDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, 'adapter.js'), `throw new Error('adapter broke');`);
}

/**
 * Write an adapter module that imports fine but does NOT register anything.
 */
function writeNonRegisteringAdapter(bridgeDir: string): void {
  const srcDir = path.join(bridgeDir, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(srcDir, 'adapter.js'), `// does nothing\nexport default {};\n`);
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

// ── collectBridgeSecretEnv ─────────────────────────────────────────────

test('collectBridgeSecretEnv returns the union of secretEnv across bridges', async () => {
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
        secretEnv: ['DISCORD_BOT_TOKEN'],
      }),
    );

    const slackDir = path.join(appsDir, 'slack');
    mkdirSync(slackDir);
    writeFileSync(
      path.join(slackDir, 'plugin.json'),
      JSON.stringify({
        name: 'slack',
        label: 'Slack',
        kind: 'bridge',
        version: '1.0.0',
        secretEnv: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
      }),
    );

    const names = await collectBridgeSecretEnv(appsDir);
    assert.deepEqual(
      [...names].sort(),
      ['DISCORD_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'],
    );
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('collectBridgeSecretEnv dedupes and ignores bridges without secretEnv', async () => {
  const appsDir = createTmpAppsDir();
  try {
    for (const name of ['a', 'b']) {
      const dir = path.join(appsDir, name);
      mkdirSync(dir);
      writeFileSync(
        path.join(dir, 'plugin.json'),
        JSON.stringify({
          name,
          label: name,
          kind: 'bridge',
          version: '1.0.0',
          secretEnv: ['SHARED_TOKEN'],
        }),
      );
    }
    // A bridge with no secretEnv at all.
    const cDir = path.join(appsDir, 'c');
    mkdirSync(cDir);
    writeFileSync(
      path.join(cDir, 'plugin.json'),
      JSON.stringify({ name: 'c', label: 'c', kind: 'bridge', version: '1.0.0' }),
    );

    const names = await collectBridgeSecretEnv(appsDir);
    assert.deepEqual(names, ['SHARED_TOKEN']);
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

// ── loadBridges ────────────────────────────────────────────────────────

test('loadBridges returns empty when no bridges discovered', async () => {
  const appsDir = createTmpAppsDir();
  try {
    const { logger } = createTestLogger();
    const started = await loadBridges({
      runnerUrl: 'http://127.0.0.1:9999',
      logger,
      appsDir,
    });
    assert.deepEqual(started, []);
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('loadBridges skips bridges with missing required env vars', async () => {
  const appsDir = createTmpAppsDir();
  try {
    const dir = path.join(appsDir, 'testbridge');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'testbridge',
        label: 'Test Bridge',
        kind: 'bridge',
        version: '1.0.0',
        requiredEnv: ['SOME_TOKEN'],
      }),
    );

    const { logger, calls } = createTestLogger();
    const started = await loadBridges({
      runnerUrl: 'http://127.0.0.1:9999',
      logger,
      env: {}, // no SOME_TOKEN
      appsDir,
    });

    assert.deepEqual(started, []);
    const skipMsg = calls.find((c) => c.msg.includes('Skipping'));
    assert.ok(skipMsg, 'should log a skip message');
    assert.ok(skipMsg.msg.includes('SOME_TOKEN'), 'skip message should mention the missing var');
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('loadBridges starts a ready bridge with a valid adapter', async () => {
  const appsDir = createTmpAppsDir();
  const bridgeName = `fakebridge_${Date.now()}`;
  try {
    const dir = path.join(appsDir, bridgeName);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: bridgeName,
        label: 'Fake Bridge',
        kind: 'bridge',
        version: '1.0.0',
        requiredEnv: ['FAKE_TOKEN'],
      }),
    );
    writeFakeAdapter(dir, bridgeName);

    const { logger } = createTestLogger();
    const started = await loadBridges({
      runnerUrl: 'http://127.0.0.1:9999',
      logger,
      env: { FAKE_TOKEN: 'secret' },
      appsDir,
    });

    assert.deepEqual(started, [bridgeName]);
    assert.ok(bridgeRegistry.getInstance(bridgeName), 'adapter instance should be in the registry');
  } finally {
    await bridgeRegistry.stopAdapter(bridgeName);
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('loadBridges handles adapter import failure gracefully', async () => {
  const appsDir = createTmpAppsDir();
  try {
    const dir = path.join(appsDir, 'broken');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'broken',
        label: 'Broken Bridge',
        kind: 'bridge',
        version: '1.0.0',
      }),
    );
    writeBrokenAdapter(dir);

    const { logger, calls } = createTestLogger();
    const started = await loadBridges({
      runnerUrl: 'http://127.0.0.1:9999',
      logger,
      env: {},
      appsDir,
    });

    assert.deepEqual(started, []);
    const errorMsg = calls.find((c) => c.level === 'error');
    assert.ok(errorMsg, 'should log an error for the broken adapter');
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('loadBridges warns when adapter imports but does not register', async () => {
  const appsDir = createTmpAppsDir();
  const bridgeName = `ghost_${Date.now()}`;
  try {
    const dir = path.join(appsDir, bridgeName);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: bridgeName,
        label: 'Ghost Bridge',
        kind: 'bridge',
        version: '1.0.0',
      }),
    );
    writeNonRegisteringAdapter(dir);

    const { logger, calls } = createTestLogger();
    const started = await loadBridges({
      runnerUrl: 'http://127.0.0.1:9999',
      logger,
      env: {},
      appsDir,
    });

    assert.deepEqual(started, []);
    const warnMsg = calls.find((c) => c.level === 'warn');
    assert.ok(warnMsg, 'should log a warning when adapter does not register');
    assert.ok(warnMsg.msg.includes('not registered'), 'warning should mention not registered');
  } finally {
    rmSync(appsDir, { recursive: true, force: true });
  }
});

test('loadBridges starts only ready bridges in a mixed set', async () => {
  const appsDir = createTmpAppsDir();
  const readyName = `ready_${Date.now()}`;
  try {
    // Ready bridge — has required env
    const readyDir = path.join(appsDir, readyName);
    mkdirSync(readyDir);
    writeFileSync(
      path.join(readyDir, 'plugin.json'),
      JSON.stringify({
        name: readyName,
        label: 'Ready',
        kind: 'bridge',
        version: '1.0.0',
        requiredEnv: ['READY_TOKEN'],
      }),
    );
    writeFakeAdapter(readyDir, readyName);

    // Not-ready bridge — missing required env
    const notReadyDir = path.join(appsDir, 'notready');
    mkdirSync(notReadyDir);
    writeFileSync(
      path.join(notReadyDir, 'plugin.json'),
      JSON.stringify({
        name: 'notready',
        label: 'Not Ready',
        kind: 'bridge',
        version: '1.0.0',
        requiredEnv: ['MISSING_TOKEN'],
      }),
    );

    // Non-bridge — should be ignored entirely
    const toolDir = path.join(appsDir, 'sometool');
    mkdirSync(toolDir);
    writeFileSync(
      path.join(toolDir, 'plugin.json'),
      JSON.stringify({ name: 'sometool', label: 'Tool', kind: 'tool', version: '1.0.0' }),
    );

    const { logger } = createTestLogger();
    const started = await loadBridges({
      runnerUrl: 'http://127.0.0.1:9999',
      logger,
      env: { READY_TOKEN: 'yes' },
      appsDir,
    });

    assert.deepEqual(started, [readyName]);
  } finally {
    await bridgeRegistry.stopAdapter(readyName);
    rmSync(appsDir, { recursive: true, force: true });
  }
});
