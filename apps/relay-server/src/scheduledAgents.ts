/** Product specializations for trusted, isolated scheduled runs. Never selected by request tags. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';

export interface ScheduledAgentOptions { configPath?: string; homeDir?: string }
export interface ScheduledAgentConfig {
  profile: string;
  context_files: string[];
  tools: string[];
  slack?: { workspace_id: string; user_id: string; workspace_url: string; state_dir: string };
}
export const SCHEDULED_AGENT_TOOL_NAMES = [
  'terminal', 'file_editor', 'glob', 'grep', 'finish', 'think', 'switch_llm',
  'send_media', 'send_message', 'schedule_task', 'update_task', 'list_tasks', 'pause_task', 'resume_task', 'cancel_task',
  'check_slack', 'recover_slack', 'notify_smolpaws',
] as const;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(name);
const fields = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
function invalid(): never { throw new Error('Invalid SmolPaws scheduled agent configuration'); }
const resolveFile = (file: string, base: string): string => path.resolve(base,
  file === '~' ? homedir() : file.startsWith('~/') ? path.join(homedir(), file.slice(2)) : file);

function parseConfig(value: unknown, base: string): Record<string, ScheduledAgentConfig> {
  if (!record(value) || value.version !== 1 || !fields(value, ['version', 'tasks']) || !record(value.tasks)) invalid();
  const tasks: Record<string, ScheduledAgentConfig> = Object.create(null) as Record<string, ScheduledAgentConfig>;
  for (const [taskId, entry] of Object.entries(value.tasks)) {
    if (!name(taskId) || !record(entry) || !fields(entry, ['profile', 'context_files', 'tools', 'slack'])
      || !name(entry.profile) || !list(entry.context_files) || !list(entry.tools)
      || new Set(entry.tools).size !== entry.tools.length
      || entry.tools.some(tool => !(SCHEDULED_AGENT_TOOL_NAMES as readonly string[]).includes(tool))) invalid();
    const config: ScheduledAgentConfig = {
      profile: entry.profile, context_files: entry.context_files.map(file => resolveFile(file, base)), tools: entry.tools,
    };
    if (entry.slack !== undefined) {
      const slack = entry.slack;
      if (!record(slack) || !fields(slack, ['workspace_id', 'user_id', 'workspace_url', 'state_dir'])
        || !name(slack.workspace_id) || !/^T[A-Z0-9]+$/.test(slack.workspace_id)
        || !name(slack.user_id) || !/^[UW][A-Z0-9]+$/.test(slack.user_id)
        || slack.workspace_url !== `https://app.slack.com/client/${slack.workspace_id}` || !name(slack.state_dir)) invalid();
      config.slack = { workspace_id: slack.workspace_id, user_id: slack.user_id,
        workspace_url: slack.workspace_url, state_dir: resolveFile(slack.state_dir, base) };
    }
    if (entry.tools.some(tool => ['check_slack', 'recover_slack', 'notify_smolpaws'].includes(tool)) && !config.slack) invalid();
    tasks[taskId] = config;
  }
  return tasks;
}

/** Read on each use; only a scheduler-created isolated run may select a task configuration. */
export function loadScheduledAgent(conversationId: string, scheduler: TaskScheduler, options: ScheduledAgentOptions = {}): ScheduledAgentConfig | undefined {
  const task = scheduler.isolatedTask(conversationId);
  if (!task) return undefined;
  const home = options.homeDir ?? (process.env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws'));
  const explicit = options.configPath ?? (process.env.SMOLPAWS_SCHEDULED_AGENTS_CONFIG?.trim() || undefined);
  const file = resolveFile(explicit ?? path.join(home, 'scheduled-agents.json'), process.cwd());
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (explicit === undefined && record(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  // JSON errors can contain input text, including a credential accidentally put in this file.
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  return parseConfig(value, path.dirname(file))[task.id];
}
