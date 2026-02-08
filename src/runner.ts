import Fastify from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  LocalConversation,
  Workspace,
  type Event,
  type Message,
  type OpenHandsSettings,
  type TextContent,
  SecretRegistry,
  createConfirmationPolicyFromSettings,
  LLMSecurityAnalyzer,
  reduceTextContent,
} from "@smolpaws/agent-sdk";
import { randomUUID } from "crypto";
import os from "node:os";
import path from "node:path";
import type { SmolpawsQueueMessage } from "./shared/github.js";

const DEFAULT_MODEL_ENV = "LLM_MODEL";
const DEFAULT_API_KEY_ENV = "LLM_API_KEY";

const TextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
  },
  { additionalProperties: true },
);

const ContentSchema = Type.Union([
  TextContentSchema,
  Type.Object({ type: Type.String() }, { additionalProperties: true }),
]);

const MessageSchema = Type.Object(
  {
    role: Type.String(),
    content: Type.Array(ContentSchema),
    extended_content: Type.Optional(Type.Array(ContentSchema)),
    run: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

const StaticSecretSchema = Type.Object(
  {
    kind: Type.Literal("StaticSecret"),
    value: Type.String(),
  },
  { additionalProperties: true },
);

const SecretValueSchema = Type.Union([Type.String(), StaticSecretSchema]);

const RemoteSecurityAnalyzerSchema = Type.Object(
  {
    kind: Type.Literal("LLMSecurityAnalyzer"),
  },
  { additionalProperties: true },
);

const ConfirmationPolicySchema = Type.Union([
  Type.Object({ kind: Type.Literal("AlwaysConfirm") }, { additionalProperties: true }),
  Type.Object({ kind: Type.Literal("NeverConfirm") }, { additionalProperties: true }),
  Type.Object(
    {
      kind: Type.Literal("ConfirmRisky"),
      threshold: Type.Union([
        Type.Literal("LOW"),
        Type.Literal("MEDIUM"),
        Type.Literal("HIGH"),
      ]),
      confirm_unknown: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
  ),
]);

const LlmSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    base_url: Type.Optional(Type.String()),
    api_key: Type.Optional(Type.String()),
    api_version: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
    temperature: Type.Optional(Type.Number()),
    top_p: Type.Optional(Type.Number()),
    top_k: Type.Optional(Type.Number()),
    max_input_tokens: Type.Optional(Type.Number()),
    max_output_tokens: Type.Optional(Type.Number()),
    reasoning_effort: Type.Optional(Type.String()),
    reasoning_summary: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const WorkspaceSchema = Type.Object(
  {
    kind: Type.Optional(Type.String()),
    working_dir: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const AgentSchema = Type.Object(
  {
    llm: LlmSchema,
    tools: Type.Optional(Type.Array(Type.Any())),
    security_analyzer: Type.Optional(RemoteSecurityAnalyzerSchema),
  },
  { additionalProperties: true },
);

const StartConversationRequestSchema = Type.Object(
  {
    agent: AgentSchema,
    workspace: Type.Optional(WorkspaceSchema),
    secrets: Type.Optional(Type.Record(Type.String(), SecretValueSchema)),
    confirmation_policy: Type.Optional(ConfirmationPolicySchema),
    max_iterations: Type.Optional(Type.Number()),
    stuck_detection: Type.Optional(Type.Boolean()),
    stuck_detection_thresholds: Type.Optional(Type.Record(Type.String(), Type.Number())),
    initial_message: Type.Optional(MessageSchema),
    conversation_id: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const SuccessSchema = Type.Object({ success: Type.Boolean() });

const EventSchema = Type.Object(
  {
    kind: Type.String(),
  },
  { additionalProperties: true },
);

const EventPageSchema = Type.Object({
  items: Type.Array(EventSchema),
  next_page_id: Type.Optional(Type.String()),
});

const ConversationInfoSchema = Type.Object({
  id: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  execution_status: Type.String(),
});

const AskAgentRequestSchema = Type.Object({ question: Type.String() });
const AskAgentResponseSchema = Type.Object({ response: Type.String() });

const GenerateTitleRequestSchema = Type.Object({
  max_length: Type.Optional(Type.Number()),
  llm: Type.Optional(Type.Any()),
});
const GenerateTitleResponseSchema = Type.Object({ title: Type.String() });

const ConfirmationResponseSchema = Type.Object({
  accept: Type.Boolean(),
  reason: Type.Optional(Type.String()),
});

const SetSecretsRequestSchema = Type.Object({
  secrets: Type.Record(Type.String(), SecretValueSchema),
});

const SetConfirmationPolicyRequestSchema = Type.Object({
  policy: ConfirmationPolicySchema,
});

const SetSecurityAnalyzerRequestSchema = Type.Object({
  security_analyzer: Type.Optional(RemoteSecurityAnalyzerSchema),
});

const RunRequestSchema = Type.Object({
  event: Type.Union([
    Type.Literal("issue_comment"),
    Type.Literal("pull_request_review_comment"),
  ]),
  payload: Type.Any(),
  delivery_id: Type.Optional(Type.String()),
});

const RunResponseSchema = Type.Object({
  reply: Type.String(),
});

const ServerInfoSchema = Type.Object({
  uptime: Type.Number(),
  idle_time: Type.Number(),
  title: Type.String(),
  version: Type.String(),
  docs: Type.String(),
  redoc: Type.String(),
});

type StartConversationRequest = Static<typeof StartConversationRequestSchema>;
type ConversationInfo = Static<typeof ConversationInfoSchema>;
type EventPage = Static<typeof EventPageSchema>;
type RunRequest = Static<typeof RunRequestSchema>;
type RunResponse = Static<typeof RunResponseSchema>;
type AskAgentRequest = Static<typeof AskAgentRequestSchema>;
type AskAgentResponse = Static<typeof AskAgentResponseSchema>;
type GenerateTitleRequest = Static<typeof GenerateTitleRequestSchema>;
type GenerateTitleResponse = Static<typeof GenerateTitleResponseSchema>;
type ConfirmationResponseRequest = Static<typeof ConfirmationResponseSchema>;
type SetSecretsRequest = Static<typeof SetSecretsRequestSchema>;
type SetConfirmationPolicyRequest = Static<typeof SetConfirmationPolicyRequestSchema>;
type SetSecurityAnalyzerRequest = Static<typeof SetSecurityAnalyzerRequestSchema>;

type RunnerEnv = {
  SMOLPAWS_RUNNER_TOKEN?: string;
  RUNNER_PORT?: string;
  PORT?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  SMOLPAWS_WORKSPACE_ROOT?: string;
  SMOLPAWS_PERSISTENCE_DIR?: string;
};

type ConversationRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  conversation: LocalConversation;
  events: Event[];
  settings: OpenHandsSettings;
  secrets: SecretRegistry;
  workspaceRoot: string;
};

type AuthResult = {
  allowed: boolean;
  reason?: string;
};

const conversations = new Map<string, ConversationRecord>();
const serverStart = Date.now();
let lastEventAt = Date.now();

function getEnv(): RunnerEnv {
  return {
    SMOLPAWS_RUNNER_TOKEN: process.env.SMOLPAWS_RUNNER_TOKEN,
    RUNNER_PORT: process.env.RUNNER_PORT,
    PORT: process.env.PORT,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_API_KEY: process.env.LLM_API_KEY,
    SMOLPAWS_WORKSPACE_ROOT: process.env.SMOLPAWS_WORKSPACE_ROOT,
    SMOLPAWS_PERSISTENCE_DIR: process.env.SMOLPAWS_PERSISTENCE_DIR,
  };
}

const DEFAULT_PERSISTENCE_DIR = path.join(
  os.homedir(),
  ".openhands",
  "conversations",
);

function resolvePersistenceDir(env: RunnerEnv): string {
  const raw =
    env.SMOLPAWS_PERSISTENCE_DIR ??
    process.env.OPENHANDS_CONVERSATIONS_DIR ??
    "";
  const value = raw.trim();
  if (!value) {
    return DEFAULT_PERSISTENCE_DIR;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}


function normalizeHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isAuthorized(
  request: { headers: Record<string, string | string[] | undefined> },
  env: RunnerEnv,
): AuthResult {
  const token = env.SMOLPAWS_RUNNER_TOKEN;
  if (!token) {
    return { allowed: true };
  }
  const authorization = normalizeHeader(request.headers.authorization);
  if (!authorization) {
    return { allowed: false, reason: "Missing Authorization header" };
  }
  const [scheme, value] = authorization.split(" ");
  if (scheme !== "Bearer" || value !== token) {
    return { allowed: false, reason: "Invalid Authorization token" };
  }
  return { allowed: true };
}

function buildReplyFromComment(message: SmolpawsQueueMessage): string {
  const actor = message.payload.sender?.login ?? "there";
  const repo = message.payload.repository?.full_name ?? "your repo";
  const body = message.payload.comment?.body ?? "";
  const trimmed = body.replace(/@smolpaws/gi, "").trim();
  const requestLine = trimmed ? `Request: "${trimmed}"` : "Request: (none)";
  return `🐾 Hey ${actor}! smolpaws is warming up in ${repo}.\n${requestLine}`;
}

function normalizeSecretValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { kind?: unknown; value?: unknown };
  if (record.kind === "StaticSecret" && typeof record.value === "string") {
    const trimmed = record.value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function registerSecrets(
  secrets: Record<string, unknown> | undefined,
  registry: SecretRegistry,
  settings: OpenHandsSettings,
): void {
  if (!secrets) {
    return;
  }
  for (const [key, raw] of Object.entries(secrets)) {
    const value = normalizeSecretValue(raw);
    if (!value) continue;
    registry.register(key, value);
    if (key === "GITHUB_TOKEN") settings.secrets.githubToken = value;
    if (key === "ELEVENLABS_API_KEY") settings.secrets.halTtsApiKey = value;
    if (key === "CUSTOM_SECRET_1") settings.secrets.customSecret1 = value;
    if (key === "CUSTOM_SECRET_2") settings.secrets.customSecret2 = value;
    if (key === "CUSTOM_SECRET_3") settings.secrets.customSecret3 = value;
  }
}

function extractWorkingDir(request: StartConversationRequest): string {
  const workingDir = request.workspace?.working_dir;
  if (typeof workingDir === "string" && workingDir.trim()) {
    return workingDir.trim();
  }
  return process.cwd();
}

function buildSettingsFromRequest(
  request: StartConversationRequest,
  registry: SecretRegistry,
): OpenHandsSettings {
  const llm = request.agent.llm;
  const model = typeof llm.model === "string" ? llm.model.trim() : "";
  if (!model) {
    throw new Error("LLM model is required");
  }
  const settings: OpenHandsSettings = {
    llm: {
      provider: typeof llm.provider === "string" ? llm.provider : undefined,
      model,
      baseUrl: typeof llm.base_url === "string" ? llm.base_url : undefined,
      apiVersion: typeof llm.api_version === "string" ? llm.api_version : undefined,
      timeout: typeof llm.timeout === "number" ? llm.timeout : undefined,
      temperature: typeof llm.temperature === "number" ? llm.temperature : undefined,
      topP: typeof llm.top_p === "number" ? llm.top_p : undefined,
      topK: typeof llm.top_k === "number" ? llm.top_k : undefined,
      maxInputTokens:
        typeof llm.max_input_tokens === "number"
          ? llm.max_input_tokens
          : undefined,
      maxOutputTokens:
        typeof llm.max_output_tokens === "number"
          ? llm.max_output_tokens
          : undefined,
      reasoningEffort:
        typeof llm.reasoning_effort === "string"
          ? llm.reasoning_effort
          : undefined,
      reasoningSummary:
        typeof llm.reasoning_summary === "string"
          ? llm.reasoning_summary
          : undefined,
    },
    agent: {
      enableSecurityAnalyzer: Boolean(request.agent.security_analyzer),
      debug: false,
      summarizeToolCalls: false,
    },
    conversation: {
      maxIterations:
        typeof request.max_iterations === "number"
          ? request.max_iterations
          : undefined,
      stuckDetection:
        typeof request.stuck_detection === "boolean"
          ? request.stuck_detection
          : undefined,
      stuckThresholds: request.stuck_detection_thresholds
        ? {
            actionObservation: request.stuck_detection_thresholds.actionObservation,
            actionError: request.stuck_detection_thresholds.actionError,
            monologue: request.stuck_detection_thresholds.monologue,
            alternatingPattern:
              request.stuck_detection_thresholds.alternatingPattern,
          }
        : undefined,
    },
    confirmation: {
      policy: "never",
      riskyThreshold: "HIGH",
      confirmUnknown: true,
    },
    secrets: {
      llmApiKey:
        typeof llm.api_key === "string" ? llm.api_key : undefined,
      awsAccessKeyId: (llm as { aws_access_key_id?: string }).aws_access_key_id,
      awsSecretAccessKey: (llm as { aws_secret_access_key?: string })
        .aws_secret_access_key,
    },
  };

  if (request.confirmation_policy?.kind === "AlwaysConfirm") {
    settings.confirmation.policy = "always";
  } else if (request.confirmation_policy?.kind === "ConfirmRisky") {
    settings.confirmation.policy = "risky";
    settings.confirmation.riskyThreshold =
      request.confirmation_policy.threshold ?? "HIGH";
    settings.confirmation.confirmUnknown =
      request.confirmation_policy.confirm_unknown ?? true;
  }

  registerSecrets(request.secrets, registry, settings);

  return settings;
}

function buildSettingsFromEnv(env: RunnerEnv): OpenHandsSettings {
  const model = env.LLM_MODEL ?? process.env[DEFAULT_MODEL_ENV];
  if (!model) {
    throw new Error(
      `LLM model is required. Set ${DEFAULT_MODEL_ENV} or LLM_MODEL.`,
    );
  }

  return {
    llm: {
      provider: env.LLM_PROVIDER,
      model,
      baseUrl: env.LLM_BASE_URL,
    },
    agent: {
      enableSecurityAnalyzer: false,
      debug: false,
      summarizeToolCalls: false,
    },
    conversation: {
      maxIterations: 50,
      stuckDetection: true,
    },
    confirmation: {
      policy: "never",
      riskyThreshold: "HIGH",
      confirmUnknown: true,
    },
    secrets: {
      llmApiKey: env.LLM_API_KEY ?? process.env[DEFAULT_API_KEY_ENV],
    },
  };
}

function extractMessageText(content: TextContent[]): string {
  const message: Message = {
    role: "user",
    content,
  };
  return reduceTextContent(message).trim();
}

function extractTextFromRequest(message?: {
  content?: TextContent[];
  extended_content?: TextContent[];
}): string {
  if (!message?.content?.length) return "";
  return extractMessageText(message.content);
}

async function runStandaloneQuestion(
  settings: OpenHandsSettings,
  prompt: string,
  workspaceRoot?: string,
  persistenceDir?: string,
): Promise<string> {
  const registry = new SecretRegistry();
  const conversation = new LocalConversation({
    settings,
    workspace: Workspace({ kind: "local", root: workspaceRoot }),
    secrets: registry,
    includeDefaultTools: false,
    persistenceDir,
  });
  const responses: string[] = [];
  conversation.on("event", (event: Event) => {
    if (event.kind === "MessageEvent" && event.llm_message?.role === "assistant") {
      const content = event.llm_message.content as TextContent[];
      const text = extractMessageText(content);
      if (text) responses.push(text);
    }
  });
  await conversation.sendUserMessage(prompt);
  return responses[responses.length - 1] ?? "";
}

function createConversationRecord(
  request: StartConversationRequest,
  persistenceDir?: string,
): ConversationRecord {
  const id = randomUUID();
  const registry = new SecretRegistry();
  const settings = buildSettingsFromRequest(request, registry);
  const workspaceRoot = extractWorkingDir(request);
  const workspace = Workspace({ kind: "local", root: workspaceRoot });
  const conversation = new LocalConversation({
    settings,
    workspace,
    secrets: registry,
    includeDefaultTools: true,
    persistenceDir,
  });

  const record: ConversationRecord = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conversation,
    events: [],
    settings,
    secrets: registry,
    workspaceRoot,
  };

  conversation.on("event", (event: Event) => {
    record.events.push(event);
    record.updatedAt = new Date().toISOString();
    lastEventAt = Date.now();
  });

  conversations.set(id, record);
  return record;
}

function getConversationOrThrow(id: string): ConversationRecord {
  const record = conversations.get(id);
  if (!record) {
    throw new Error("conversation_not_found");
  }
  return record;
}

function buildConversationInfo(record: ConversationRecord): ConversationInfo {
  return {
    id: record.id,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    execution_status: "running",
  };
}

async function applyConfirmationPolicy(
  record: ConversationRecord,
  request: SetConfirmationPolicyRequest,
): Promise<void> {
  const policy = request.policy;
  if (policy.kind === "AlwaysConfirm") {
    await record.conversation.setConfirmationPolicy(
      createConfirmationPolicyFromSettings({ policy: "always" }),
    );
    return;
  }
  if (policy.kind === "ConfirmRisky") {
    await record.conversation.setConfirmationPolicy(
      createConfirmationPolicyFromSettings({
        policy: "risky",
        riskyThreshold: policy.threshold,
        confirmUnknown: policy.confirm_unknown ?? true,
      }),
    );
    return;
  }
  await record.conversation.setConfirmationPolicy(
    createConfirmationPolicyFromSettings({ policy: "never" }),
  );
}

async function applySecurityAnalyzer(
  record: ConversationRecord,
  request: SetSecurityAnalyzerRequest,
): Promise<void> {
  if (request.security_analyzer?.kind === "LLMSecurityAnalyzer") {
    await record.conversation.setSecurityAnalyzer(new LLMSecurityAnalyzer());
    return;
  }
  await record.conversation.setSecurityAnalyzer(null);
}

function listEvents(
  record: ConversationRecord,
  params: { pageId?: string; limit?: number },
): EventPage {
  const limit =
    typeof params.limit === "number" && params.limit > 0
      ? Math.min(100, Math.trunc(params.limit))
      : 100;
  const offset = params.pageId ? Number(params.pageId) : 0;
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const items = record.events.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + items.length;
  return {
    items,
    next_page_id: nextOffset < record.events.length ? String(nextOffset) : undefined,
  };
}

function extractPromptFromComment(comment?: string | null): string {
  if (!comment) return "";
  return comment.replace(/@smolpaws/gi, "").trim();
}

function extractPromptFromMessage(message: SmolpawsQueueMessage): string {
  const comment = message.payload.comment?.body ?? "";
  return extractPromptFromComment(comment);
}

function generateTitleFromEvents(
  events: Event[],
  maxLength: number,
): string {
  const userMessages = events.filter(
    (event) => event.kind === "MessageEvent" && event.llm_message?.role === "user",
  );
  const base = userMessages
    .map((event) =>
      extractMessageText(event.llm_message.content as TextContent[]),
    )
    .find((text) => text.trim().length > 0);
  const fallback = base ?? "Conversation";
  return fallback.slice(0, Math.max(1, maxLength)).trim();
}

async function start(): Promise<void> {
  const env = getEnv();
  const persistenceDir = resolvePersistenceDir(env);
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

  app.get("/health", async () => ({ ok: true }));
  app.get("/alive", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));
  app.get(
    "/server_info",
    {
      schema: {
        response: { 200: ServerInfoSchema },
      },
    },
    async () => ({
      uptime: Math.floor((Date.now() - serverStart) / 1000),
      idle_time: Math.floor((Date.now() - lastEventAt) / 1000),
      title: "smolpaws agent server",
      version: "0.0.1",
      docs: "/docs",
      redoc: "/redoc",
    }),
  );

  app.post<{ Body: RunRequest; Reply: RunResponse }>(
    "/run",
    {
      schema: {
        body: RunRequestSchema,
        response: {
          200: RunResponseSchema,
          401: RunResponseSchema,
        },
      },
    },
    async (request, reply): Promise<RunResponse> => {
      const auth = isAuthorized(request, env);
      if (!auth.allowed) {
        reply.status(401);
        return { reply: auth.reason ?? "Unauthorized" };
      }

      const message = request.body as SmolpawsQueueMessage;
      const prompt = extractPromptFromMessage(message);
      if (!prompt) {
        return { reply: buildReplyFromComment(message) };
      }

      try {
        const settings = buildSettingsFromEnv(env);
        const response = await runStandaloneQuestion(
          settings,
          prompt,
          env.SMOLPAWS_WORKSPACE_ROOT,
          persistenceDir,
        );
        return { reply: response || buildReplyFromComment(message) };
      } catch (error) {
        console.error("Runner error", error);
        return { reply: buildReplyFromComment(message) };
      }
    },
  );

  app.post<{ Body: StartConversationRequest; Reply: ConversationInfo }>(
    "/api/conversations",
    {
      schema: {
        body: StartConversationRequestSchema,
        response: {
          200: ConversationInfoSchema,
          201: ConversationInfoSchema,
        },
      },
    },
    async (request, reply): Promise<ConversationInfo> => {
      const record = createConversationRecord(request.body, persistenceDir);
      if (request.body.initial_message) {
        const messageText = extractTextFromRequest(request.body.initial_message);
        if (messageText) {
          await record.conversation.sendUserMessage(messageText, {
            run: request.body.initial_message.run !== false,
            extendedContent: request.body.initial_message
              .extended_content as TextContent[] | undefined,
          });
        }
      }
      reply.status(201);
      return buildConversationInfo(record);
    },
  );

  app.get<{ Params: { conversationId: string }; Reply: ConversationInfo }>(
    "/api/conversations/:conversationId",
    {
      schema: { response: { 200: ConversationInfoSchema } },
    },
    async (request): Promise<ConversationInfo> => {
      const record = getConversationOrThrow(request.params.conversationId);
      return buildConversationInfo(record);
    },
  );

  app.post<{ Params: { conversationId: string }; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/pause",
    {
      schema: { response: { 200: SuccessSchema } },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      await record.conversation.pause();
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/run",
    {
      schema: { response: { 200: SuccessSchema } },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      await record.conversation.resume();
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: SetConfirmationPolicyRequest; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/confirmation_policy",
    {
      schema: {
        body: SetConfirmationPolicyRequestSchema,
        response: { 200: SuccessSchema },
      },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      await applyConfirmationPolicy(record, request.body);
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: SetSecurityAnalyzerRequest; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/security_analyzer",
    {
      schema: {
        body: SetSecurityAnalyzerRequestSchema,
        response: { 200: SuccessSchema },
      },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      await applySecurityAnalyzer(record, request.body);
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: SetSecretsRequest; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/secrets",
    {
      schema: {
        body: SetSecretsRequestSchema,
        response: { 200: SuccessSchema },
      },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      registerSecrets(request.body.secrets, record.secrets, record.settings);
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: AskAgentRequest; Reply: AskAgentResponse }>(
    "/api/conversations/:conversationId/ask_agent",
    {
      schema: {
        body: AskAgentRequestSchema,
        response: { 200: AskAgentResponseSchema },
      },
    },
    async (request): Promise<AskAgentResponse> => {
      const record = getConversationOrThrow(request.params.conversationId);
      const response = await runStandaloneQuestion(
        record.settings,
        request.body.question,
        record.workspaceRoot,
        persistenceDir,
      );
      return { response };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: GenerateTitleRequest; Reply: GenerateTitleResponse }>(
    "/api/conversations/:conversationId/generate_title",
    {
      schema: {
        body: GenerateTitleRequestSchema,
        response: { 200: GenerateTitleResponseSchema },
      },
    },
    async (request): Promise<GenerateTitleResponse> => {
      const record = getConversationOrThrow(request.params.conversationId);
      const maxLength =
        typeof request.body.max_length === "number"
          ? Math.max(1, Math.trunc(request.body.max_length))
          : 50;
      return { title: generateTitleFromEvents(record.events, maxLength) };
    },
  );

  app.post<{ Params: { conversationId: string }; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/condense",
    {
      schema: { response: { 200: SuccessSchema } },
    },
    async (): Promise<Static<typeof SuccessSchema>> => ({ success: true }),
  );

  app.post<{ Params: { conversationId: string }; Body: ConfirmationResponseRequest; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/events/respond_to_confirmation",
    {
      schema: {
        body: ConfirmationResponseSchema,
        response: { 200: SuccessSchema },
      },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      if (request.body.accept) {
        await record.conversation.approveAction();
      } else {
        await record.conversation.rejectAction(request.body.reason);
      }
      return { success: true };
    },
  );

  app.post<{ Params: { conversationId: string }; Body: Static<typeof MessageSchema>; Reply: Static<typeof SuccessSchema> }>(
    "/api/conversations/:conversationId/events",
    {
      schema: {
        body: MessageSchema,
        response: { 200: SuccessSchema },
      },
    },
    async (request): Promise<Static<typeof SuccessSchema>> => {
      const record = getConversationOrThrow(request.params.conversationId);
      if (request.body.role !== "user") {
        throw new Error("only_user_messages_supported");
      }
      const content = request.body.content as TextContent[];
      const messageText = extractMessageText(content);
      await record.conversation.sendUserMessage(messageText, {
        run: request.body.run !== false,
        extendedContent: request.body.extended_content as TextContent[] | undefined,
      });
      return { success: true };
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { page_id?: string; limit?: number }; Reply: EventPage }>(
    "/api/conversations/:conversationId/events/search",
    {
      schema: { response: { 200: EventPageSchema } },
    },
    async (request): Promise<EventPage> => {
      const record = getConversationOrThrow(request.params.conversationId);
      return listEvents(record, {
        pageId: request.query.page_id,
        limit:
          typeof request.query.limit === "string"
            ? Number(request.query.limit)
            : request.query.limit,
      });
    },
  );

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Error && error.message === "conversation_not_found") {
      reply.status(404).send({ error: "Conversation not found" });
      return;
    }
    if (error instanceof Error && error.message === "only_user_messages_supported") {
      reply.status(400).send({ error: "Only user messages are supported" });
      return;
    }
    reply.status(500).send({ error: error.message });
  });

  const port = Number(env.PORT ?? env.RUNNER_PORT ?? 8788);
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  console.error("Runner failed to start", error);
  process.exit(1);
});
