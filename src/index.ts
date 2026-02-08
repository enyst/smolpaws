import type {
  GithubEventPayload,
  SmolpawsEvent,
  SmolpawsQueueMessage,
} from "./shared/github.js";

interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  ALLOWED_ACTORS?: string;
  ALLOWED_OWNERS?: string;
  ALLOWED_REPOS?: string;
  SMOLPAWS_QUEUE: Queue<SmolpawsQueueMessage>;

  ALLOWED_INSTALLATIONS?: string;
  SMOLPAWS_RUNNER_URL?: string;
  SMOLPAWS_RUNNER_TOKEN?: string;
}

const MENTION = "@smolpaws";
const USER_AGENT = "smolpaws-webhook";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method !== "POST" || url.pathname !== "/webhooks/github") {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();

    if (!env.GITHUB_WEBHOOK_SECRET) {
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const signature = request.headers.get("X-Hub-Signature-256");
    if (!signature) {
      return new Response("Missing signature", { status: 401 });
    }

    const signatureValid = await verifySignature(
      rawBody,
      env.GITHUB_WEBHOOK_SECRET,
      signature,
    );

    if (!signatureValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const event = parseEvent(request.headers.get("X-GitHub-Event") ?? "");
    if (!event) {
      return new Response("Ignored", { status: 200 });
    }

    let payload: GithubEventPayload;
    try {
      payload = JSON.parse(rawBody) as GithubEventPayload;
    } catch (error) {
      console.error("Invalid JSON", error);
      return new Response("Invalid payload", { status: 400 });
    }

    if (payload.action && payload.action !== "created") {
      return new Response("Ignored", { status: 200 });
    }

    const commentBody = payload.comment?.body ?? "";
    if (!containsMention(commentBody)) {
      return new Response("Ignored", { status: 200 });
    }

    if (!isAllowed(payload, env)) {
      return new Response("Ignored", { status: 200 });
    }

    const installationId = payload.installation?.id;
    const repoFullName = payload.repository?.full_name;
    const issueNumber = payload.issue?.number ?? payload.pull_request?.number;
    if (!installationId || !repoFullName || !issueNumber) {
      return new Response("Missing repository context", { status: 400 });
    }

    const queueMessage: SmolpawsQueueMessage = {
      event,
      payload,
      delivery_id: request.headers.get("X-GitHub-Delivery") ?? undefined,
    };

    await env.SMOLPAWS_QUEUE.send(queueMessage);

    return new Response("Queued", { status: 202 });
  },

  async queue(
    batch: MessageBatch<SmolpawsQueueMessage>,
    env: Env,
  ): Promise<void> {
    await Promise.all(
      batch.messages.map((message) => processQueueMessage(message, env)),
    );
  },
} satisfies ExportedHandler<Env>;

function parseList(value?: string): Set<string> {
  if (!value) {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseEvent(event: string): SmolpawsEvent | null {
  if (event === "issue_comment" || event === "pull_request_review_comment") {
    return event;
  }
  return null;
}

function containsMention(body: string): boolean {
  return new RegExp(`(^|\\s)${MENTION}\\b`, "i").test(body);
}

function isAllowed(payload: GithubEventPayload, env: Env): boolean {
  const allowedActors = parseList(env.ALLOWED_ACTORS);
  const allowedOwners = parseList(env.ALLOWED_OWNERS);
  const allowedRepos = parseList(env.ALLOWED_REPOS);
  const allowedInstallations = parseList(env.ALLOWED_INSTALLATIONS);

  const actor = payload.sender?.login?.toLowerCase();
  const owner = payload.repository?.owner?.login?.toLowerCase();
  const repo = payload.repository?.full_name?.toLowerCase();
  const installationId = payload.installation?.id?.toString();

  if (allowedActors.size && (!actor || !allowedActors.has(actor))) {
    return false;
  }

  if (allowedOwners.size && (!owner || !allowedOwners.has(owner))) {
    return false;
  }

  if (allowedRepos.size && (!repo || !allowedRepos.has(repo))) {
    return false;
  }

  if (
    allowedInstallations.size &&
    (!installationId || !allowedInstallations.has(installationId))
  ) {
    return false;
  }

  return true;
}

async function processQueueMessage(
  message: Message<SmolpawsQueueMessage>,
  env: Env,
): Promise<void> {
  const { payload } = message.body;
  const installationId = payload.installation?.id;
  const repoFullName = payload.repository?.full_name;
  const issueNumber = payload.issue?.number ?? payload.pull_request?.number;

  if (!installationId || !repoFullName || !issueNumber) {
    console.error("Queue message missing repository context", {
      delivery_id: message.body.delivery_id,
    });
    message.ack();
    return;
  }

  try {
    const token = await createInstallationToken(installationId, env);
    const runnerReply = await dispatchToRunner(message.body, env);
    const replyBody =
      runnerReply ??
      "🐾 smolpaws heard you and is waking up. Runner is not configured yet.";

    await postIssueComment({
      token,
      repoFullName,
      issueNumber,
      body: replyBody,
    });

    message.ack();
  } catch (error) {
    console.error("Queue message processing failed", error);
    message.retry({ delaySeconds: 30 });
  }
}


async function verifySignature(
  rawBody: string,
  secret: string,
  signatureHeader: string,
): Promise<boolean> {
  const [algorithm, signature] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !signature) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const digestHex = bufferToHex(digest);
  return timingSafeEqual(`sha256=${digestHex}`, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function createInstallationToken(
  installationId: number,
  env: Env,
): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials not configured");
  }

  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to get installation token: ${message}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

async function createAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = base64UrlEncode(signature);
  return `${signingInput}.${encodedSignature}`;
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const trimmed = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(trimmed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function postIssueComment(options: {
  token: string;
  repoFullName: string;
  issueNumber: number;
  body: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${options.repoFullName}/issues/${options.issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body: options.body }),
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to post comment: ${message}`);
  }
}

async function dispatchToRunner(
  message: SmolpawsQueueMessage,
  env: Env,
): Promise<string | null> {
  if (!env.SMOLPAWS_RUNNER_URL) {
    return null;
  }

  const response = await fetch(env.SMOLPAWS_RUNNER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.SMOLPAWS_RUNNER_TOKEN
        ? { Authorization: `Bearer ${env.SMOLPAWS_RUNNER_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Runner error: ${responseText}`);
  }

  const data = (await response.json()) as { reply?: string };
  return data.reply ?? null;
}
