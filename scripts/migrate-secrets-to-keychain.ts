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

const KEYS_TO_MIGRATE = [
  'LITELLM_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'NVIDIA_API_KEY',
  'LITELLM_API_KEY_EVAL',
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

  for (const key of KEYS_TO_MIGRATE) {
    const envValue = env[key];
    if (!envValue) {
      console.log(`  ${key}: not in .env — skip`);
      skipped++;
      continue;
    }

    const existing = await keychainGet(key);
    if (existing) {
      if (existing === envValue) {
        console.log(`  ${key}: already in Keychain (same value) ✓`);
      } else {
        console.log(`  ${key}: already in Keychain (DIFFERENT value) ⚠️  — skipping, review manually`);
      }
      alreadyInKeychain++;
      continue;
    }

    if (dryRun) {
      console.log(`  ${key}: would migrate (${envValue.length} chars)`);
    } else {
      const ok = await keychainSet(key, envValue);
      if (ok) {
        console.log(`  ${key}: migrated to Keychain ✓`);
        migrated++;
      } else {
        console.log(`  ${key}: FAILED to store in Keychain ✗`);
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
