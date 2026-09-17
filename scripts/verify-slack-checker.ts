/** Opt-in live provider smoke. All conversations, queues, browser results and deliveries are fixtures. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import Database from 'better-sqlite3';
import { createRelayServerApp } from '../apps/relay-server/src/app.js';
import { SlackChecker, type SlackCheckerBrowser } from '../apps/relay-server/src/slackChecker.js';
import { RelayRuntime } from '../src/coordinator/relayRuntime.js';
import { TaskScheduler } from '../src/coordinator/taskScheduler.js';
import type * as Sdk from '../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const sdk = createRequire(import.meta.url)('../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;
const toolNames = ['terminal', 'check_slack', 'recover_slack', 'notify_smolpaws', 'finish'];
const cases = ['quiet', 'activity', 'recovery', 'unrecoverable'] as const;
type Scenario = typeof cases[number];
const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const call = (name: string, args: unknown) => sdk.messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: `${name}-fixture`, name, arguments: JSON.stringify(args), origin: 'completion' }] });
let providerCalls = 0;

function readProfile(profileId: string, stateFile?: string): Sdk.LLMProfile {
  const home = process.env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws');
  const stateDir = process.env.OPENHANDS_AGENT_SERVER_STATE_PATH?.trim() || path.join(
    process.env.OPENHANDS_CONVERSATIONS_PATH?.trim() || path.join(home, 'conversations'), 'server_state');
  // Read only the selected profile. Never construct a mutable service over the production store.
  try {
    const state: unknown = JSON.parse(readFileSync(stateFile ?? path.join(stateDir, 'state.json'), 'utf8'));
    const profile = sdk.llmProfileSchema.parse((state as { llmProfiles?: Record<string, unknown> }).llmProfiles?.[profileId]);
    assert.equal(profile.profileId, profileId);
    assert.equal(profile.providerId, 'deepseek', 'This smoke only permits the inexpensive DeepSeek provider.');
    return sdk.llmProfileSchema.parse({ ...profile, timeoutSeconds: 45, maxOutputTokens: Math.min(profile.maxOutputTokens ?? 2048, 2048) });
  } catch { throw new Error('Could not load the selected DeepSeek profile from the local server state.'); }
}

function browserFixture(scenario: Scenario, history: string[]): SlackCheckerBrowser {
  const item = { source_id: 'slack:TTEST:CTEST:1758157200.000001', kind: 'mention', ts: '1758157200.000001',
    channel: 'CTEST', channel_name: 'fixture', user: 'UHUMAN', author_name: 'Fixture human',
    text: 'Please ask SmolPaws to review the Slack checker handoff.', permalink: 'https://app.slack.com/archives/CTEST/p1758157200000001' };
  return {
    async evaluate(_script, selection) {
      history.push(`evaluate:${selection}`);
      if (scenario === 'unrecoverable') return JSON.stringify({ ok: false, error: 'slack_login_required' });
      if (scenario === 'recovery' && selection === 'first') return 'CHROME_TAB_EXECUTION_FAILED';
      const items = scenario === 'activity' ? [item] : [];
      return JSON.stringify({ ok: true, items, next: { last_ts: item.ts, followed: {} } });
    },
    async recover(action) { history.push(`recover:${action}`); },
  };
}

async function verify(scenario: Scenario, profile: Sdk.LLMProfile, secrets: Sdk.SecretStore): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'smolpaws-checker-live-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const configPath = path.join(root, 'scheduled-agents.json');
  const contextPath = path.join(root, 'context.json');
  const modelsPath = path.join(root, 'models.json');
  const prompt = readFileSync(fileURLToPath(new URL('../docs/prompts/slack-checker.md', import.meta.url)), 'utf8');
  writeFileSync(path.join(root, 'checker.md'), prompt, { mode: 0o600 });
  writeFileSync(path.join(root, 'memory.md'), 'FULL_OWNER_MEMORY_FIXTURE');
  writeFileSync(contextPath, JSON.stringify({ version: 1, files: ['memory.md'] }));
  writeFileSync(modelsPath, JSON.stringify({ version: 1 }));
  writeFileSync(configPath, JSON.stringify({ version: 1, tasks: {} }));
  const schedulerPath = path.join(root, 'scheduler.db');
  const scheduler = new TaskScheduler(schedulerPath);
  const browserCalls: string[] = [];
  const browser = browserFixture(scenario, browserCalls);
  const helperResponses: Sdk.LLMCompletionResponse[] = [];
  const deliveries: Array<{ text?: string }> = [];
  let fatal: Error | undefined;
  let runtime: RelayRuntime | undefined;
  let server: Awaited<ReturnType<typeof createRelayServerApp>> | undefined;
  const perCallSummaries: unknown[] = [];
  try {
    server = await createRelayServerApp({ logger: false, secretStore: secrets,
      scheduledAgents: { configPath }, context: { configPath: contextPath }, models: { configPath: modelsPath },
      slackCheckerFactory: options => new SlackChecker(options, browser),
      config: { sessionApiKey: null, conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
        bashEventsPath: path.join(root, 'bash'), workspaceRoot: workspace, allowedFileRoots: [workspace] },
      llmClientFactory: async selected => {
        if (selected.profileId === 'fixture-owner') return sdk.TestLLM.fromMessages([
          call('finish', { message: 'fixture owner ready' }), call('finish', { message: 'fixture owner handled Slack' }),
        ], { profile: selected });
        assert.equal(selected.profileId, profile.profileId);
        const client = await sdk.createClientFromProfile(selected, secrets);
        return { profile: selected, async complete(messages, tools) {
          try {
            assert.deepEqual(tools?.map(tool => tool.name), toolNames);
            const system = messages.filter(message => message.role === 'system').flatMap(message => message.content)
              .filter(part => part.type === 'text').map(part => part.text).join('\n');
            assert.ok(system.includes('lightweight Slack-checking helper'));
            assert.ok(!system.includes('FULL_OWNER_MEMORY_FIXTURE'));
            assert.ok(providerCalls < 30, 'Live smoke request budget exhausted.');
            providerCalls++;
            const startedAt = Date.now();
            const response = await client.complete(messages, tools);
            helperResponses.push(response);
            const record = sdk.createLlmUsageEvent(selected, response, { startedAt, completedAt: Date.now() }).value as Sdk.UsageRecord;
            const usage = record.usage;
            const summary = { type: 'llm_response', scenario, call: providerCalls, model: record.model,
              input_tokens: usage?.promptTokens ?? null, output_tokens: usage?.completionTokens ?? null,
              cache_read_tokens: usage?.cacheReadTokens ?? null, cache_write_tokens: usage?.cacheWriteTokens ?? null,
              cost: record.cost === null ? null : { amount: record.cost.amount, currency: record.cost.currency, source: record.cost.source },
              tools: response.message.tool_calls?.map(tool => tool.name) ?? [] };
            perCallSummaries.push(summary); output(summary);
            // Include the real terminal schema in prompt measurements, but refuse before executing any
            // generated terminal call. Fake browser recovery is sufficient for every fixture here.
            assert.ok(!response.message.tool_calls?.some(tool => tool.name === 'terminal'), 'Smoke rejected a terminal call before execution.');
            return response;
          } catch {
            // Provider exceptions may contain response bodies: emit only this fixed safe message.
            fatal = new Error('Live checker completion or smoke safety assertion failed; no provider body is printed.');
            throw fatal;
          }
        } };
      },
    }, scheduler);
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    runtime = new RelayRuntime({ platform: 'whatsapp', logger: pino({ level: 'silent' }), serverUrl: address,
      dbPath: path.join(root, 'relay.db'), schedulerDbPath: schedulerPath,
      createConversationDefaults: { workspace: { working_dir: workspace }, tags: { scope: 'openhands' },
        agent: { llm_profile_ref: 'fixture-owner' }, max_iterations: 10 },
      target: { validate() {}, async deliver(_lane, payload) { deliveries.push(payload as { text?: string }); return {}; } },
    });
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await runtime!.runOnce();
        if (fatal) throw fatal;
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('Live checker fixture timed out.');
    };
    await server.serverStateService.saveProfile(sdk.llmProfileSchema.parse({ profileId: 'fixture-owner', providerId: 'openai', model: 'fixture' }));
    await server.serverStateService.saveProfile(profile);
    const lane = { laneKey: 'whatsapp:fixture-openhands', platform: 'whatsapp', accountId: 'fixture', chatId: 'fixture', threadId: null };
    await runtime.accept({ lane, message: { sourceMessageId: 'initial', content: 'Initialize the fixture owner.' } });
    await until(() => deliveries.some(item => item.text === 'fixture owner ready'));
    const ownerId = runtime.workStore.getLane(lane.laneKey)!.conversationId;
    const created = scheduler.execute(ownerId, 'schedule_task', { prompt: 'Check Slack now using your normal instructions. Finish silently after a quiet check or accepted handoff; report an unrecoverable obstacle concisely.',
      schedule_type: 'once', schedule_value: new Date(Date.now() - 1).toISOString(), context_mode: 'isolated' }, `live-${scenario}`);
    assert.equal(created.is_error, false);
    const taskId = (JSON.parse(created.text) as { task_id: string }).task_id;
    writeFileSync(configPath, JSON.stringify({ version: 1, tasks: { [taskId]: { profile: profile.profileId,
      context_files: ['checker.md'], tools: toolNames,
      slack: { workspace_id: 'TTEST', user_id: 'UTEST', workspace_url: 'https://app.slack.com/client/TTEST', state_dir: 'slack-state' },
    } } }));
    const status = () => (scheduler.db.prepare('SELECT status FROM scheduler_tasks WHERE id=?').get(taskId) as { status: string }).status;
    await until(() => status() === 'completed');
    const run = scheduler.db.prepare('SELECT conversation_id, status FROM scheduler_runs WHERE task_id=?').get(taskId) as { conversation_id: string; status: string };
    assert.equal(run.status, 'done', 'The checker must finish without a conversation error.');
    if (scenario === 'activity') await until(() => deliveries.some(item => item.text === 'fixture owner handled Slack'));
    const service = (await server.conversationService.getEventService(run.conversation_id))!;
    const events = (await service.searchEvents()).items;
    const actions = events.filter(event => event.kind === 'ActionEvent');
    assert.equal(actions[0]?.tool_name, 'check_slack');
    assert.ok(helperResponses.length > 0);
    const finishes = events.flatMap(event => event.kind === 'ObservationEvent' && event.tool_name === 'finish' ? [event] : []);
    if (scenario !== 'unrecoverable') assert.equal(finishes.length, 1, 'Successful checks must use exactly one finish call.');
    const lastMessage = helperResponses.at(-1)!.message;
    const text = finishes.length ? String((finishes.at(-1)!.observation as { message?: string; text?: string }).message ?? (finishes.at(-1)!.observation as { text?: string }).text ?? '')
      : lastMessage.content.filter(part => part.type === 'text').map(part => part.text).join('');
    await until(() => scenario === 'unrecoverable' ? deliveries.length >= 2 : true);
    await runtime.runOnce();
    const db = new Database(path.join(root, 'relay.db'), { readonly: true, fileMustExist: true });
    let notificationCount: { n: number };
    try { notificationCount = db.prepare("SELECT COUNT(*) AS n FROM work WHERE kind='intake' AND lane_key=? AND source_key LIKE '%:slack-checker:%'").get(lane.laneKey) as { n: number }; }
    finally { db.close(); }
    assert.equal(notificationCount.n, scenario === 'activity' ? 1 : 0);
    if (scenario === 'unrecoverable') {
      assert.ok(text.trim().length > 0 && text.length < 1000, 'Failure must be concise and visible.');
      assert.match(text, /slack|login|log.in|sign.in/i);
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1].text, text);
    } else {
      assert.equal(text, '', 'Successful checks must finish silently.');
      assert.deepEqual(deliveries.map(item => item.text), scenario === 'activity'
        ? ['fixture owner ready', 'fixture owner handled Slack'] : ['fixture owner ready']);
    }
    if (scenario === 'recovery') assert.deepEqual(browserCalls, ['evaluate:first', 'evaluate:others']);
    if (scenario === 'quiet' || scenario === 'activity') assert.deepEqual(browserCalls, ['evaluate:first']);
    const metrics = sdk.metricsSnapshot(sdk.statsForEvents(events));
    output({ type: 'scenario_pass', scenario, calls: perCallSummaries.length, browser_operations: browserCalls,
      tool_calls: actions.map(action => action.tool_name), notifications: notificationCount.n,
      input_tokens: metrics.accumulated_token_usage.prompt_tokens, cache_read_tokens: metrics.accumulated_token_usage.cache_read_tokens,
      output_tokens: metrics.accumulated_token_usage.completion_tokens, costs: metrics.known_costs, cost_sources: metrics.cost_sources,
      missing_cost_count: metrics.coverage.missing_cost_count });
  } finally {
    if (runtime) await runtime.stop();
    if (server) await server.app.close(); else scheduler.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { live: { type: 'boolean' }, profile: { type: 'string', default: 'deepseek-v4-flash' },
    'state-file': { type: 'string' }, scenario: { type: 'string', default: 'all' } } });
  if (!values.live) throw new Error('Refusing provider calls without --live. Usage: npx tsx scripts/verify-slack-checker.ts --live [--profile deepseek-v4-flash] [--scenario all]');
  if (values.scenario !== 'all' && !(cases as readonly string[]).includes(values.scenario!)) throw new Error('Unknown smoke scenario.');
  const profile = readProfile(values.profile!, values['state-file']);
  const keychain = new sdk.MacOSKeychainSecretStore();
  const secrets: Sdk.SecretStore = { get: ref => keychain.get(ref), has: ref => keychain.has(ref),
    async set() { throw new Error('Live smoke cannot write Keychain secrets.'); }, async delete() { throw new Error('Live smoke cannot delete Keychain secrets.'); } };
  for (const scenario of cases) if (values.scenario === 'all' || values.scenario === scenario) await verify(scenario, profile, secrets);
  output({ type: 'smoke_pass', profile: profile.profileId, provider_calls: providerCalls });
}
void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Slack checker smoke failed.'}\n`); process.exitCode = 1; });
