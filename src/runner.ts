import Fastify from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { GithubEventPayload } from "./shared/github.js";

type RunnerEnv = {
  SMOLPAWS_RUNNER_TOKEN?: string;
  RUNNER_PORT?: string;
  PORT?: string;
};

const GithubPayloadSchema = Type.Object(
  {
    action: Type.Optional(Type.String()),
    sender: Type.Optional(
      Type.Object(
        {
          login: Type.Optional(Type.String()),
          id: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
    comment: Type.Optional(
      Type.Object(
        {
          body: Type.Optional(Type.String()),
          id: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
    repository: Type.Optional(
      Type.Object(
        {
          full_name: Type.Optional(Type.String()),
          owner: Type.Optional(
            Type.Object(
              {
                login: Type.Optional(Type.String()),
              },
              { additionalProperties: true },
            ),
          ),
        },
        { additionalProperties: true },
      ),
    ),
    issue: Type.Optional(
      Type.Object(
        {
          number: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
    pull_request: Type.Optional(
      Type.Object(
        {
          number: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
    installation: Type.Optional(
      Type.Object(
        {
          id: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const EventSchema = Type.Union([
  Type.Literal("issue_comment"),
  Type.Literal("pull_request_review_comment"),
]);

const RunRequestSchema = Type.Object({
  event: EventSchema,
  payload: GithubPayloadSchema,
});

const RunResponseSchema = Type.Object({
  reply: Type.String(),
});

type RunRequest = Static<typeof RunRequestSchema>;
type RunResponse = Static<typeof RunResponseSchema>;

type RunRequestPayload = RunRequest["payload"];

type AuthResult = {
  allowed: boolean;
  reason?: string;
};

function getEnv(): RunnerEnv {
  return {
    SMOLPAWS_RUNNER_TOKEN: process.env.SMOLPAWS_RUNNER_TOKEN,
    RUNNER_PORT: process.env.RUNNER_PORT,
    PORT: process.env.PORT,
  };
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

function buildReply(payload: RunRequestPayload): string {
  const data = payload as GithubEventPayload;
  const actor = data.sender?.login ?? "there";
  const repo = data.repository?.full_name ?? "your repo";
  const body = data.comment?.body ?? "";
  const trimmed = body.replace(/@smolpaws/gi, "").trim();
  const requestLine = trimmed ? `Request: "${trimmed}"` : "Request: (none)";
  return `🐾 Hey ${actor}! smolpaws is warming up in ${repo}.\n${requestLine}`;
}

async function start(): Promise<void> {
  const env = getEnv();
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: RunRequest; Reply: RunResponse }>(
    "/run",
    {
      schema: {
        body: RunRequestSchema,
        response: {
          200: RunResponseSchema,
        },
      },
    },
    async (request, reply): Promise<RunResponse> => {
      const auth = isAuthorized(request, env);
      if (!auth.allowed) {
        reply.status(401);
        return { reply: auth.reason ?? "Unauthorized" };
      }

      return { reply: buildReply(request.body.payload) };
    },
  );

  const port = Number(env.PORT ?? env.RUNNER_PORT ?? 8788);
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  console.error("Runner failed to start", error);
  process.exit(1);
});
