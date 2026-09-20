/** Small product tools for explicitly configured isolated scheduled agents. */
import { createRequire } from 'node:module';
import { z } from 'zod';
import { notifySmolpaws } from '../../../src/coordinator/notifySmolpaws.js';
import type { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import type { ScheduledAgentConfig } from './scheduledAgents.js';
import { SlackChecker, type SlackCheckerOptions } from './slackChecker.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';

const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;
export type SlackCheckerPort = Pick<SlackChecker, 'check' | 'recover' | 'pendingSourceIds' | 'acknowledge'>;
export type SlackCheckerFactory = (options: SlackCheckerOptions) => SlackCheckerPort;

/** Some checker responses put serialized finish arguments inside message itself. */
function slackFinishMessage(message: string): string {
  try {
    const value: unknown = JSON.parse(message);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.keys(value).length === 1 && 'message' in value
      && typeof value.message === 'string' && value.message.trim().length === 0) return '';
  } catch { /* Ordinary finish text is not JSON. */ }
  return message;
}

export function scheduledAgentTools(
  scheduler: TaskScheduler,
  conversationId: string,
  config: ScheduledAgentConfig,
  createChecker: SlackCheckerFactory = options => new SlackChecker(options),
): readonly Sdk.ToolDefinition[] {
  const checker = config.slack === undefined ? undefined : createChecker(config.slack);
  const tools: Sdk.ToolDefinition[] = [];
  if (checker) {
    const finish = sdk.FinishTool.create();
    // Scope the adaptation to Slack helpers; keep the SDK schemas and finish semantics.
    tools.push(new sdk.ToolDefinition({
      ...finish,
      executor: (action, context) => finish.execute({ ...action, message: slackFinishMessage(action.message) }, context),
    }));
    tools.push(new sdk.ToolDefinition({
      name: 'check_slack',
      description: 'Check new Slack mentions and followed-thread replies in the existing Google Chrome Slack tab. Background tabs work. Returns quiet, activity with source_ids and links, or an error. Activity remains pending until notify_smolpaws accepts it. Does not wake SmolPaws or send Slack messages.',
      inputSchema: z.object({}).strict(),
      executor: async () => {
        const result = await checker.check();
        return { text: JSON.stringify(result), is_error: result.status === 'error' };
      },
    }), new sdk.ToolDefinition({
      name: 'recover_slack',
      description: 'Recover only after finding or using Slack in Chrome fails. Try other Slack tabs first. Then optionally keep the first-opened Chrome window, reopen one Chrome window, or open the configured Slack URL. Never controls Comet. Each recovery retries the Slack check and returns its result.',
      inputSchema: z.object({ action: z.enum(['try_other_tabs', 'keep_first_window', 'reopen_window', 'open_slack']) }).strict(),
      executor: async ({ action }) => {
        const result = await checker.recover(action);
        return { text: JSON.stringify(result), is_error: result.status === 'error' };
      },
    }));
  }
  tools.push(new sdk.ToolDefinition({
    name: 'notify_smolpaws',
    description: 'Hand Slack findings to the full SmolPaws conversation that owns this scheduled task. For this checker that is the WhatsApp OpenHands group. Supply a concise message with links and every source_id returned by check_slack. The tool durably queues an automatic user message and acknowledges the checked batch only after acceptance. Retries with the same IDs are deduplicated. Accepted means queued, not that SmolPaws has already replied.',
    inputSchema: z.object({ message: z.string().trim().min(1).max(32_000), source_ids: z.array(z.string().trim().min(1).max(500)).min(1) }).strict(),
    executor: async (action) => {
      try {
        const receipt = notifySmolpaws(scheduler, conversationId, action, Date.now(), () => {
          if (!checker) return;
          const expected = checker.pendingSourceIds().slice().sort();
          const supplied = action.source_ids.slice().sort();
          if (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(supplied)) {
            throw new Error('Use every source_id from the current check_slack activity result; no matching pending batch was found.');
          }
        });
        if (checker) await checker.acknowledge(action.source_ids);
        return { text: JSON.stringify(receipt), is_error: false };
      } catch (error) {
        return { text: error instanceof Error ? error.message : 'Unable to queue the SmolPaws notification; retry the same source IDs.', is_error: true };
      }
    },
  }));
  return tools;
}
