/**
 * macOS Keychain integration for provider secrets.
 *
 * Reads secrets from the macOS Keychain using the `security` CLI.
 * Service name: "openhands" — consistent with OH-Tab's VS Code SecretStorage.
 *
 * Usage:
 *   await keychainGet("LITELLM_API_KEY")   → string | null
 *   await keychainSet("LITELLM_API_KEY", "sk-...")
 *   await loadKeychainSecrets()            → sets process.env from Keychain
 */

import { execFile } from 'node:child_process';

const SERVICE = 'openhands';

function exec(cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      resolve({ stdout: stdout?.trim() ?? '', exitCode: error ? 1 : 0 });
    });
  });
}

/** Read a secret from the Keychain. Returns null if not found. */
export async function keychainGet(account: string): Promise<string | null> {
  const { stdout, exitCode } = await exec('security', [
    'find-generic-password', '-s', SERVICE, '-a', account, '-w',
  ]);
  return exitCode === 0 && stdout ? stdout : null;
}

/** Store a secret in the Keychain. Overwrites if exists (-U). */
export async function keychainSet(account: string, value: string): Promise<boolean> {
  const { exitCode } = await exec('security', [
    'add-generic-password', '-s', SERVICE, '-a', account, '-w', value, '-U',
  ]);
  return exitCode === 0;
}

/** Delete a secret from the Keychain. */
export async function keychainDelete(account: string): Promise<boolean> {
  const { exitCode } = await exec('security', [
    'delete-generic-password', '-s', SERVICE, '-a', account,
  ]);
  return exitCode === 0;
}

/** Known provider secret keys to look for in the Keychain. */
const PROVIDER_KEYS = [
  'LITELLM_API_KEY_APP',
  'LITELLM_API_KEY_EVAL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'NVIDIA_API_KEY',
  'OPENHANDS_API_KEY',
  'SMOLPAWS_OPENHANDS_API_KEY',
];

/**
 * Load secrets from macOS Keychain into process.env.
 * Keychain takes priority — existing env vars are NOT overwritten
 * unless `overwrite` is true.
 *
 * Returns the list of keys that were loaded.
 */
export async function loadKeychainSecrets(
  keys = PROVIDER_KEYS,
  overwrite = false,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const key of keys) {
    if (!overwrite && process.env[key]) continue;
    const value = await keychainGet(key);
    if (value) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
