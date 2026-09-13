import path from 'node:path';

import {
  Agent,
  AgentContext,
  CancelTaskTool,
  FileEditorTool,
  FinishTool,
  GlobTool,
  GrepTool,
  ListTasksTool,
  PauseTaskTool,
  ResumeTaskTool,
  ScheduleTaskTool,
  SendMessageTool,
  TerminalTool,
  ThinkTool,
  createClientFromProfile,
  llmProfileSchema,
  validateAgentSettings,
  type LLMClient,
  type LLMProfile,
  type SecretStore,
  type ToolDefinition,
} from '@smolpaws/openhands-agent';
import { z } from 'zod';

import type { AgentFactory } from './eventService.js';
import { publicStartConversationRequestSchema, startConversationRequestSchema, type StartConversationRequest } from './models.js';
import type { ServerStateService } from './serverState.js';

export type ProfileLlmClientFactory = (profile: LLMProfile, secretStore: SecretStore) => Promise<LLMClient>;

interface ProfileAgentFactoryOptions {
  readonly state: ServerStateService;
  readonly secretStore: SecretStore;
  readonly llmClientFactory?: ProfileLlmClientFactory;
}

const defaultToolNames = ['terminal', 'file_editor', 'glob', 'grep', 'finish', 'think'] as const;

/**
 * Caller-supplied conversation context, the subset of upstream `Agent.agent_context` that a start
 * request may carry. It rides on the request's `agent` field next to the profile-first settings and is
 * applied when the conversation's Agent is built. Skills, secrets, and datetime stay runtime-owned.
 */
export const agentContextRequestSchema = z
  .object({
    system_message_suffix: z.string().nullable().default(null),
    user_message_suffix: z.string().nullable().default(null),
  })
  .strict();
export type AgentContextRequest = z.infer<typeof agentContextRequestSchema>;

export function agentContextFromRequestAgent(requestAgent: unknown): AgentContextRequest | null {
  if (!isRecord(requestAgent) || requestAgent.agent_context === undefined || requestAgent.agent_context === null) return null;
  return agentContextRequestSchema.parse(requestAgent.agent_context);
}

export function createProfileAgentFactory(options: ProfileAgentFactoryOptions): AgentFactory {
  const createLlmClient = options.llmClientFactory ?? createClientFromProfile;
  return async (requestAgent, context) => {
    const settings = validateAgentSettings(isRecord(requestAgent) ? withoutAgentContext(requestAgent) : (await options.state.settings()).agent_settings);
    if (settings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
    const profile = await resolveProfileForConversation(context.stored.request, settings.llm_profile_ref, options.state);
    const workingDir = path.resolve(context.stored.workspace.working_dir);
    // `tools` is nullable in the SDK schema: `null` (unset) and `[]` both mean "use the
    // server default set", preserving the behavior of the previous non-nullable default.
    const configuredTools = settings.tools ?? [];
    const toolSpecs = configuredTools.length === 0 ? defaultToolNames : configuredTools;
    const agentContext = agentContextFromRequestAgent(requestAgent);
    return new Agent({
      llm: await createLlmClient(profile, options.secretStore),
      tools: toolSpecs.flatMap((spec) => resolveProfileTool(spec, workingDir)),
      toolConcurrencyLimit: settings.tool_concurrency_limit,
      ...(agentContext === null
        ? {}
        : {
          context: new AgentContext({
            systemMessageSuffix: agentContext.system_message_suffix,
            userMessageSuffix: agentContext.user_message_suffix,
          }),
        }),
    });
  };
}

export async function prepareProfileStartRequest(input: unknown, state: ServerStateService): Promise<StartConversationRequest> {
  const request = publicStartConversationRequestSchema.parse(input);
  const hasRequestedMaxIterations = isRecord(input) && Object.hasOwn(input, 'max_iterations');
  const settings = await state.settings();
  // A request `agent` that names its own `llm_profile_ref` fully replaces the server's agent settings
  // (upstream shape). A partial `agent` (for example only `agent_context`) overlays the server defaults
  // so product callers can attach conversation context without re-stating the whole profile choice.
  const requestAgent = isRecord(request.agent) ? request.agent : undefined;
  const agentContext = agentContextFromRequestAgent(requestAgent);
  // `agent_context` is not an agent *setting* (settings schemas are strict and persisted); it is carried
  // beside the validated settings on the stored request only.
  const requestSettings = requestAgent === undefined ? {} : withoutAgentContext(requestAgent);
  const effectiveAgent = requestAgent === undefined
    ? settings.agent_settings
    : Object.hasOwn(requestSettings, 'llm_profile_ref') ? requestSettings : { ...settings.agent_settings, ...requestSettings };
  const agentSettings = validateAgentSettings(effectiveAgent);
  if (agentSettings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
  const profile = await state.getProfile(agentSettings.llm_profile_ref);
  if (profile === null) throw new Error(`llm_profile_not_found:${agentSettings.llm_profile_ref}`);
  return startConversationRequestSchema.parse({
    ...request,
    agent: agentContext === null ? agentSettings : { ...agentSettings, agent_context: agentContext },
    llm_profile_snapshot: snapshotProfile(profile),
    ...(hasRequestedMaxIterations ? {} : { max_iterations: settings.conversation_settings.max_iterations }),
  });
}

async function resolveProfileForConversation(request: StartConversationRequest, profileId: string, state: ServerStateService): Promise<LLMProfile> {
  const snapshot = request.llm_profile_snapshot;
  if (snapshot !== undefined) {
    const parsed = llmProfileSchema.parse(snapshot);
    if (parsed.profileId !== profileId) {
      throw new Error(`llm_profile_snapshot_mismatch:${profileId}`);
    }
    return snapshotProfile(parsed);
  }
  const profile = await state.getProfile(profileId);
  if (profile === null) throw new Error(`llm_profile_not_found:${profileId}`);
  return snapshotProfile(profile);
}

function snapshotProfile(profile: LLMProfile): LLMProfile {
  return llmProfileSchema.parse(JSON.parse(JSON.stringify(profile)));
}


export function resolveProfileTool(spec: unknown, workingDir: string): readonly ToolDefinition[] {
  const name = toolName(spec);
  switch (name) {
    case 'terminal': return [TerminalTool.create({ workingDir })];
    case 'file_editor': return [FileEditorTool.create({ workspaceRoot: workingDir })];
    case 'glob': return [GlobTool.create({ workingDir })];
    case 'grep': return [GrepTool.create({ workingDir })];
    case 'finish': return [FinishTool.create()];
    case 'think': return [ThinkTool.create()];
    // SmolPaws additive tools (EXT-SDK-001/002). Pure ActionEvent emitters; delivery and
    // scheduling are owned downstream by the coordinator/scheduler, not the server.
    case 'send_message': return [SendMessageTool.create()];
    case 'schedule_task': return [ScheduleTaskTool.create()];
    case 'list_tasks': return [ListTasksTool.create()];
    case 'pause_task': return [PauseTaskTool.create()];
    case 'resume_task': return [ResumeTaskTool.create()];
    case 'cancel_task': return [CancelTaskTool.create()];
    default: throw new Error(`unsupported_profile_tool:${name}`);
  }
}

function withoutAgentContext(requestAgent: Record<string, unknown>): Record<string, unknown> {
  const settings = { ...requestAgent };
  delete settings.agent_context;
  return settings;
}

function toolName(spec: unknown): string {
  if (typeof spec === 'string' && spec.length > 0) return spec;
  if (isRecord(spec) && typeof spec.name === 'string' && spec.name.length > 0) return spec.name;
  throw new Error('invalid_profile_tool');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
