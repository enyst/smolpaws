/** Product-owned context files, frozen beside conversation metadata on first use. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { conversationDirectory } from '../../../packages/openhands-agent-server/src/conversationMetadata.js';
import type { ProfileContextConfigurator } from '../../../packages/openhands-agent-server/src/profileAgentFactory.js';
import type { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { loadSmolpawsContextDocs } from '../../../src/shared/smolpawsContext.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { loadScheduledAgent, type ScheduledAgentOptions } from './scheduledAgents.js';

const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;
export interface ProductContextOptions { configPath?: string; repoRoot?: string; homeDir?: string; scheduledAgents?: ScheduledAgentOptions }
interface ContextConfig { version: 1; files?: string[]; scopes?: Record<string, string[]> }
interface ContextFile { path: string; name: string; sha256: string; content: string }
interface ContextSnapshot { version: 1; createdAt: string; scope: string; files: ContextFile[] }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);
const errno = (error: unknown, code: string): boolean => record(error) && error.code === code;

function resolveFile(file: string, base: string): string {
  return path.resolve(base, file === '~' ? homedir() : file.startsWith('~/') ? path.join(homedir(), file.slice(2)) : file);
}

function parseConfig(value: unknown): ContextConfig {
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'files', 'scopes'].includes(key))
    || (value.files !== undefined && !stringList(value.files))
    || (value.scopes !== undefined && (!record(value.scopes) || !Object.values(value.scopes).every(stringList)))) {
    throw new Error('Invalid SmolPaws context configuration');
  }
  return value as unknown as ContextConfig;
}

function parseSnapshot(value: unknown, scope: string): ContextSnapshot {
  if (!record(value) || value.version !== 1 || value.scope !== scope || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.files)) {
    throw new Error('Invalid SmolPaws context snapshot');
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!record(file) || typeof file.path !== 'string' || !path.isAbsolute(file.path)
      || typeof file.name !== 'string' || !file.name || typeof file.content !== 'string'
      || file.sha256 !== hash(file.content) || names.has(file.name) || paths.has(file.path)) {
      throw new Error('Invalid SmolPaws context snapshot file');
    }
    names.add(file.name); paths.add(file.path);
  }
  return value as unknown as ContextSnapshot;
}

async function readSnapshot(file: string, scope: string): Promise<ContextSnapshot | null> {
  try { return parseSnapshot(JSON.parse(await fs.readFile(file, 'utf8')), scope); }
  catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
}

async function capture(scope: string, options: ProductContextOptions, taskFiles?: string[]): Promise<ContextSnapshot> {
  const home = options.homeDir ?? (process.env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws'));
  const explicit = options.configPath ?? (process.env.SMOLPAWS_CONTEXT_CONFIG?.trim() || undefined);
  const configPath = resolveFile(explicit ?? path.join(home, 'context.json'), process.cwd());
  let config: ContextConfig;
  try { config = taskFiles === undefined ? parseConfig(JSON.parse(await fs.readFile(configPath, 'utf8'))) : { version: 1, files: [] }; }
  catch (error) {
    if (explicit !== undefined || !errno(error, 'ENOENT')) throw error;
    config = { version: 1 };
  }
  const defaults = config.files === undefined ? loadSmolpawsContextDocs({ repoRoot: options.repoRoot }).map(doc => doc.path) : config.files;
  const selected = taskFiles ?? [...defaults, ...(config.scopes?.[scope] ?? [])];
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  for (const selectedPath of selected) {
    const canonical = await fs.realpath(resolveFile(selectedPath, path.dirname(configPath)));
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    if (!(await fs.stat(canonical)).isFile()) throw new Error(`Context path is not a file: ${canonical}`);
    const content = await fs.readFile(canonical, 'utf8');
    files.push({ path: canonical, name: `smolpaws-context-${hash(canonical)}`, sha256: hash(content), content });
  }
  return { version: 1, createdAt: new Date().toISOString(), scope, files };
}

async function publishSnapshot(file: string, snapshot: ContextSnapshot): Promise<ContextSnapshot> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    // Atomic, without replacing a snapshot another first-use caller already published.
    try { await fs.link(temporary, file); }
    catch (error) { if (!errno(error, 'EEXIST')) throw error; }
    const published = await readSnapshot(file, snapshot.scope);
    if (published === null) throw new Error('SmolPaws context snapshot disappeared during publication');
    return published;
  } finally { await fs.rm(temporary, { force: true }); }
}

export function productContext(scheduler: TaskScheduler, options: ProductContextOptions = {}): ProfileContextConfigurator {
  return async (existing, { stored }) => {
    const lane = scheduler.lane(stored.id);
    if (!lane) throw new Error('Context requires a registered scheduler lane');
    const scope = `${lane.lane.platform}:${lane.scopeId}`;
    const snapshotPath = path.join(conversationDirectory(stored, 'workspace/conversations'), 'smolpaws-context.json');
    const snapshot = await readSnapshot(snapshotPath, scope) ?? await publishSnapshot(snapshotPath, await capture(scope, options,
      loadScheduledAgent(stored.id, scheduler, { homeDir: options.homeDir, ...options.scheduledAgents })?.context_files));
    const skills = [...(existing?.skills ?? [])];
    const names = new Set(skills.map(skill => skill.name));
    for (const file of snapshot.files) {
      let name = file.name;
      while (names.has(name)) name += '-context';
      names.add(name);
      skills.push(sdk.skillSchema.parse({ name, content: file.content, source: file.path, trigger: null, isAgentskillsFormat: false }));
    }
    const originalSuffix = existing?.systemMessageSuffix;
    // Only the old bridge's complete wrapper is ours to replace. Literal examples inside
    // another caller's suffix remain untouched.
    const suffix = originalSuffix && /^<SMOLPAWS_CONTEXT>[\s\S]*<\/SMOLPAWS_CONTEXT>$/.test(originalSuffix.trim())
      ? null : originalSuffix;
    const header = lane.lane.platform === 'agent-server' ? ''
      : `This conversation arrived through the ${lane.lane.platform} bridge. Replies are delivered back to that channel.`;
    return new sdk.AgentContext({ skills, systemMessageSuffix: [header, suffix].filter(Boolean).join('\n\n') || null,
      userMessageSuffix: existing?.userMessageSuffix, secrets: existing?.secrets, currentDatetime: existing?.currentDatetime });
  };
}
