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

import { loadSmolpawsContextSuffix, smolpawsRepoRoot } from './smolpawsContext.js';

export interface RelayConversationDefaultsOptions {
  /** Bridge name recorded in conversation tags and the context header, e.g. `slack`. */
  readonly ingress: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Override the checkout root used for docs and the fallback working dir (tests). */
  readonly repoRoot?: string;
  /** Extra absolute markdown files appended to the context (for example private memory). */
  readonly extraContextFiles?: readonly string[];
  /** Set false to omit the SmolPaws identity context (deterministic canaries). */
  readonly includeContext?: boolean;
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
  const defaults: Record<string, unknown> = {
    workspace: { kind: 'LocalWorkspace', working_dir: workingDir },
    tags: { ingress: options.ingress },
  };
  if (options.includeContext !== false) {
    const suffix = loadSmolpawsContextSuffix({
      repoRoot,
      ingress: options.ingress,
      ...(options.extraContextFiles === undefined ? {} : { extraFiles: options.extraContextFiles }),
    });
    if (suffix !== null) {
      // Upstream StartConversationRequest.agent_launch_additions: deployment context appended after profile
      // resolution. The server applies it as the agent's system-message suffix.
      defaults.agent_launch_additions = { system_message_suffix_append: suffix };
    }
  }
  return defaults;
}

/** Private durable memory the cat keeps outside the repo; attached when present. */
export function privateMemoryFiles(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const home = env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws');
  return [path.join(home, 'memory', 'MEMORY.md')];
}
