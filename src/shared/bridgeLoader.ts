/**
 * Bridge loader — discovers, validates, and starts bridge adapters
 * at agent-server startup.
 *
 * Scans apps/{name}/plugin.json for manifests where kind === "bridge".
 * Checks requiredEnv from the manifest against process.env.
 * Dynamic-imports the adapter module (which self-registers with
 * bridgeRegistry), then starts it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { bridgeRegistry } from './bridgeAdapter.js';

// ── Types ──────────────────────────────────────────────────────────────

export type PluginManifest = {
  name: string;
  label: string;
  kind: string;
  version: string;
  description?: string;
  requiredEnv?: string[];
  optionalEnv?: string[];
};

export type DiscoveredBridge = {
  name: string;
  label: string;
  dir: string;
  manifest: PluginManifest;
};

// ── Discovery ──────────────────────────────────────────────────────────

/** Resolve the apps/ directory relative to this module's location. */
function resolveAppsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/shared/bridgeLoader.ts → ../../apps
  return path.resolve(path.dirname(thisFile), '..', '..', 'apps');
}

/**
 * Scan apps/ for plugin.json manifests where kind === "bridge".
 * Returns discovered bridges sorted by name.
 */
export async function discoverBridges(
  appsDir = resolveAppsDir(),
): Promise<DiscoveredBridge[]> {
  if (!existsSync(appsDir)) return [];

  const entries = await readdir(appsDir, { withFileTypes: true });
  const bridges: DiscoveredBridge[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(appsDir, entry.name, 'plugin.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as PluginManifest;

      if (manifest.kind !== 'bridge') continue;
      if (!manifest.name || !manifest.label) continue;

      bridges.push({
        name: manifest.name,
        label: manifest.label,
        dir: path.join(appsDir, entry.name),
        manifest,
      });
    } catch {
      // Skip malformed manifests silently — not our problem
    }
  }

  return bridges.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Readiness ──────────────────────────────────────────────────────────

/** Check if all requiredEnv vars from the manifest are present. */
export function checkReadiness(
  manifest: PluginManifest,
  env: Record<string, string | undefined> = process.env,
): { ready: boolean; missing: string[] } {
  const required = manifest.requiredEnv ?? [];
  const missing = required.filter((key) => !env[key]?.trim());
  return { ready: missing.length === 0, missing };
}

// ── Startup ────────────────────────────────────────────────────────────

export type BridgeLoaderConfig = {
  runnerUrl: string;
  runnerToken?: string;
  logger: Logger;
  env?: Record<string, string | undefined>;
  appsDir?: string;
};

/**
 * Discover, validate, and start all ready bridges.
 * Returns the names of bridges that were successfully started.
 */
export async function loadBridges(config: BridgeLoaderConfig): Promise<string[]> {
  const { runnerUrl, runnerToken, logger, env, appsDir } = config;
  const bridges = await discoverBridges(appsDir);

  if (bridges.length === 0) {
    logger.debug('No bridge plugins discovered');
    return [];
  }

  logger.info(
    { bridges: bridges.map((b) => b.name) },
    `Discovered ${bridges.length} bridge plugin(s)`,
  );

  const started: string[] = [];

  for (const bridge of bridges) {
    const { ready, missing } = checkReadiness(bridge.manifest, env);

    if (!ready) {
      logger.info(
        { bridge: bridge.name, missing },
        `Skipping ${bridge.label} — missing required env: ${missing.join(', ')}`,
      );
      continue;
    }

    try {
      // Dynamic-import the adapter module, which self-registers with bridgeRegistry
      const adapterPath = path.join(bridge.dir, 'src', 'adapter.js');
      await import(adapterPath);

      if (!bridgeRegistry.has(bridge.name)) {
        logger.warn(
          { bridge: bridge.name },
          `Adapter module loaded but '${bridge.name}' not registered in bridgeRegistry — skipping`,
        );
        continue;
      }

      await bridgeRegistry.startAdapter(bridge.name, {
        runnerUrl,
        runnerToken,
        logger: logger.child({ bridge: bridge.name }),
      });

      started.push(bridge.name);
      logger.info({ bridge: bridge.name }, `Started ${bridge.label} bridge`);
    } catch (error) {
      logger.error(
        { bridge: bridge.name, error },
        `Failed to start ${bridge.label} bridge`,
      );
    }
  }

  return started;
}
