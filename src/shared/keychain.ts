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

/**
 * Known provider secrets. Each entry maps a Keychain account name
 * to the env var name the SDK expects. When they differ (e.g.
 * LITELLM_API_KEY_APP → LITELLM_API_KEY), the Keychain name is
 * for human clarity and the env name is what the runtime reads.
 */
const PROVIDER_SECRETS: Array<{ keychain: string; env: string }> = [
  { keychain: 'LITELLM_API_KEY_APP', env: 'LITELLM_API_KEY' },
  { keychain: 'LITELLM_API_KEY_EVAL', env: 'LITELLM_API_KEY_EVAL' },
  { keychain: 'OPENAI_API_KEY', env: 'OPENAI_API_KEY' },
  { keychain: 'ANTHROPIC_API_KEY', env: 'ANTHROPIC_API_KEY' },
  { keychain: 'GEMINI_API_KEY', env: 'GEMINI_API_KEY' },
  { keychain: 'NVIDIA_API_KEY', env: 'NVIDIA_API_KEY' },
  { keychain: 'OPENHANDS_API_KEY', env: 'OPENHANDS_API_KEY' },
  { keychain: 'SMOLPAWS_OPENHANDS_API_KEY', env: 'SMOLPAWS_OPENHANDS_API_KEY' },
];

/**
 * Load secrets from macOS Keychain into process.env.
 * Existing env vars are NOT overwritten unless `overwrite` is true.
 *
 * Returns the list of env var names that were loaded.
 */
export async function loadKeychainSecrets(
  secrets = PROVIDER_SECRETS,
  overwrite = false,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const { keychain, env } of secrets) {
    if (!overwrite && process.env[env]) continue;
    const value = await keychainGet(keychain);
    if (value) {
      process.env[env] = value;
      loaded.push(env);
    }
  }
  return loaded;
}
