/**
 * Conversation-creation defaults shared by every standalone relay bridge (Slack, WhatsApp, Discord).
 *
 * The upstream-shaped agent-server defaults a new conversation's workspace to `workspace/project`
 * relative to its own cwd. For a bridge that is a real place to work: the cat's home checkout. Without it
 * the terminal tool fails with "Working directory does not exist" on the first command.
 *
 * Resolution (first hit wins):
 *   1. `SMOLPAWS_WORKING_DIR` — explicit absolute path, created if missing;
 *   2. `SMOLPAWS_WORKSPACE_ROOT`/`SMOLPAWS_DEFAULT_WORKING_DIR` (same variables the heartbeat uses;
 *      defaults `~/repos` and `smolpaws`) when that directory exists;
 *   3. this repository checkout.
 */
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { smolpawsRepoRoot } from './smolpawsContext.js';

export interface RelayConversationDefaultsOptions {
  /** Bridge name recorded in conversation tags, e.g. `slack`. */
  readonly ingress: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Override the checkout root used for docs and the fallback working dir (tests). */
  readonly repoRoot?: string;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function resolveRelayWorkingDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  repoRoot: string = smolpawsRepoRoot(),
): string {
  const explicit = env.SMOLPAWS_WORKING_DIR?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  const root = env.SMOLPAWS_WORKSPACE_ROOT?.trim() || path.join(homedir(), 'repos');
  const name = env.SMOLPAWS_DEFAULT_WORKING_DIR?.trim() || 'smolpaws';
  const candidate = path.resolve(root, name);
  if (isDirectory(candidate)) return candidate;
  return path.resolve(repoRoot);
}

/** Build the extra fields a bridge passes on `POST /api/conversations` for a new lane. */
export function buildRelayConversationDefaults(options: RelayConversationDefaultsOptions): Record<string, unknown> {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? smolpawsRepoRoot();
  const workingDir = resolveRelayWorkingDir(env, repoRoot);
  return {
    workspace: { kind: 'LocalWorkspace', working_dir: workingDir },
    tags: { ingress: options.ingress },
  };
}
