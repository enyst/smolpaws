/** Canonical public identity documents; the product server selects and snapshots conversation context. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files under docs/smolpaws that are not conversation context (heartbeat checklist, directory readme). */
const EXCLUDED_CONTEXT_FILES: ReadonlySet<string> = new Set(['README.md', 'HEARTBEAT.md']);

export interface SmolpawsContextOptions {
  /** Repository root that contains docs/smolpaws. Defaults to this checkout. */
  readonly repoRoot?: string;
}

export interface SmolpawsContextDoc {
  readonly name: string;
  readonly path: string;
  readonly content: string;
}

/** The smolpaws repository root, derived from this module's location so it does not depend on cwd. */
export function smolpawsRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Load the context documents in a stable order (alphabetical by file name). */
export function loadSmolpawsContextDocs(options: SmolpawsContextOptions = {}): SmolpawsContextDoc[] {
  const repoRoot = path.resolve(options.repoRoot ?? smolpawsRepoRoot());
  const docsDir = path.join(repoRoot, 'docs', 'smolpaws');
  const docs: SmolpawsContextDoc[] = [];

  if (isDirectory(docsDir)) {
    const names = readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !EXCLUDED_CONTEXT_FILES.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const filePath = path.join(docsDir, name);
      const content = readFileSync(filePath, 'utf8').trim();
      if (content.length === 0) continue;
      docs.push({ name: `docs/smolpaws/${name}`, path: filePath, content });
    }
  }

  return docs;
}
