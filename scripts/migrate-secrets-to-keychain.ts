#!/usr/bin/env npx tsx
/**
 * Migrate provider secrets from ~/.smolpaws/.env to macOS Keychain.
 *
 * Usage: npx tsx scripts/migrate-secrets-to-keychain.ts [--dry-run]
 *
 * Reads known provider keys from the .env file and stores them in
 * the macOS Keychain under service "openhands". Does NOT delete
 * them from .env — you can do that manually after verifying.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { keychainGet, keychainSet } from '../src/shared/keychain.js';

// Keychain account name → .env var name. Same name unless noted.
// LITELLM_API_KEY_APP is stored under that name in Keychain but read
// from LITELLM_API_KEY in .env (the runtime maps it back on load).
const KEYS_TO_MIGRATE: Array<{ keychain: string; env: string }> = [
  { keychain: 'LITELLM_API_KEY_APP', env: 'LITELLM_API_KEY' },
  { keychain: 'LITELLM_API_KEY_EVAL', env: 'LITELLM_API_KEY_EVAL' },
  { keychain: 'OPENAI_API_KEY', env: 'OPENAI_API_KEY' },
  { keychain: 'ANTHROPIC_API_KEY', env: 'ANTHROPIC_API_KEY' },
  { keychain: 'GEMINI_API_KEY', env: 'GEMINI_API_KEY' },
  { keychain: 'NVIDIA_API_KEY', env: 'NVIDIA_API_KEY' },
  { keychain: 'OPENHANDS_API_KEY', env: 'OPENHANDS_API_KEY' },
  { keychain: 'SMOLPAWS_OPENHANDS_API_KEY', env: 'SMOLPAWS_OPENHANDS_API_KEY' },
  // App + bridge secrets (account name == env var name).
  { keychain: 'GITHUB_TOKEN', env: 'GITHUB_TOKEN' },
  { keychain: 'DAYTONA_KEY', env: 'DAYTONA_KEY' },
  { keychain: 'GOOGLE_CLIENT_SECRET', env: 'GOOGLE_CLIENT_SECRET' },
  { keychain: 'DISCORD_BOT_TOKEN', env: 'DISCORD_BOT_TOKEN' },
  { keychain: 'SLACK_BOT_TOKEN', env: 'SLACK_BOT_TOKEN' },
  { keychain: 'SLACK_APP_TOKEN', env: 'SLACK_APP_TOKEN' },
];

const dryRun = process.argv.includes('--dry-run');
const envPath = path.join(os.homedir(), '.smolpaws', '.env');

function parseEnvFile(filePath: string): Record<string, string> {
  const entries: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      entries[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  } catch {
    console.error(`Could not read ${filePath}`);
  }
  return entries;
}

async function main() {
  console.log(`Reading secrets from ${envPath}`);
  if (dryRun) console.log('(dry run — no changes will be made)\n');

  const env = parseEnvFile(envPath);
  let migrated = 0;
  let skipped = 0;
  let alreadyInKeychain = 0;

  for (const { keychain, env: envName } of KEYS_TO_MIGRATE) {
    const label = keychain === envName ? keychain : `${keychain} (from ${envName})`;
    const envValue = env[envName];
    if (!envValue) {
      console.log(`  ${label}: not in .env — skip`);
      skipped++;
      continue;
    }

    const existing = await keychainGet(keychain);
    if (existing) {
      if (existing === envValue) {
        console.log(`  ${label}: already in Keychain (same value) ✓`);
      } else {
        console.log(`  ${label}: already in Keychain (DIFFERENT value) ⚠️  — skipping, review manually`);
      }
      alreadyInKeychain++;
      continue;
    }

    if (dryRun) {
      console.log(`  ${label}: would migrate (${envValue.length} chars)`);
    } else {
      const ok = await keychainSet(keychain, envValue);
      if (ok) {
        console.log(`  ${label}: migrated to Keychain ✓`);
        migrated++;
      } else {
        console.log(`  ${label}: FAILED to store in Keychain ✗`);
      }
    }
  }

  console.log(`\nDone: ${migrated} migrated, ${alreadyInKeychain} already in Keychain, ${skipped} not in .env`);
  if (migrated > 0) {
    console.log('\nSecrets are now in the Keychain. You can remove them from .env when ready.');
    console.log('The agent-server will load from Keychain on startup (env vars not overwritten).');
  }
}

main().catch(console.error);
