#!/usr/bin/env node
// tomcat — a minimal sidekick agent that runs a task through the Codex CLI
// (`codex exec`) on Engel's ChatGPT/Codex Pro subscription, NOT the metered
// api.openai.com Agents API. Proof-of-life for "can a second cat ride the sub?".
//
// The sub auth lives in ~/.codex/auth.json (auth_mode: chatgpt). We do NOT touch
// it; `codex exec` reads it itself. We just shell out and parse its JSONL events.
//
// Usage:
//   node tomcat.mjs "your task"                # run a task, stream a summary
//   node tomcat.mjs --model gpt-6-astra "..."  # pick the Codex model
//   node tomcat.mjs --cd /path/to/repo "..."   # working root (default: cwd)
//   echo "task" | node tomcat.mjs              # task from stdin
//
// It prints the agent's final message and a short run summary (tokens, model,
// session id). Exit code mirrors the run outcome.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CODEX = process.env.CODEX_BIN || "codex";
const AUTH = join(homedir(), ".codex", "auth.json");

function parseArgs(argv) {
  const out = { model: "gpt-5.6-sol", cd: process.cwd(), task: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" || a === "-m") out.model = argv[++i];
    else if (a === "--cd" || a === "-C") out.cd = argv[++i];
    else rest.push(a);
  }
  out.task = rest.join(" ").trim();
  return out;
}

function assertSubAuth() {
  if (!existsSync(AUTH)) {
    throw new Error(`no Codex auth at ${AUTH} — run \`codex login\` first`);
  }
  const j = JSON.parse(readFileSync(AUTH, "utf8"));
  if (j?.auth_mode !== "chatgpt" || !j?.tokens?.access_token) {
    throw new Error(
      `Codex auth is not in ChatGPT-subscription mode (auth_mode=${j?.auth_mode}). ` +
        `Run \`codex login\` and pick "Sign in with ChatGPT".`,
    );
  }
  return { plan: decodePlan(j.tokens.access_token) };
}

// Best-effort: read chatgpt_plan_type from the JWT (no verification, just info).
function decodePlan(token) {
  try {
    const seg = token.split(".")[1];
    const pad = seg + "=".repeat((4 - (seg.length % 4)) % 4);
    const p = JSON.parse(Buffer.from(pad, "base64url").toString("utf8"));
    return p?.["https://api.openai.com/auth"]?.chatgpt_plan_type || "unknown";
  } catch {
    return "unknown";
  }
}

function run({ model, cd, task }) {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(join(tmpdir(), "tomcat-"));
    const lastMsgPath = join(tmp, "last.txt");
    const args = [
      "exec",
      "--model",
      model,
      "--cd",
      cd,
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only", // proof-of-life stays read-only; loosen deliberately later
      "--output-last-message",
      lastMsgPath,
      task || "-", // '-' => read task from stdin
    ];
    const child = spawn(CODEX, args, { stdio: ["pipe", "pipe", "pipe"] });
    if (!task) process.stdin.pipe(child.stdin);
    else child.stdin.end();

    let buf = "";
    let finalMessage = "";
    const info = { model, sessionId: null, tokens: null, outcome: "unknown" };

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        harvest(ev, info, (m) => (finalMessage = m));
      }
    });

    const stderrLines = [];
    child.stderr.on("data", (d) => stderrLines.push(d.toString()));

    child.on("close", (code) => {
      // The most reliable final answer is the --output-last-message file.
      try {
        const f = readFileSync(lastMsgPath, "utf8").trim();
        if (f) finalMessage = f;
      } catch {
        /* fall back to the streamed agent_message */
      }
      rmSync(tmp, { recursive: true, force: true });
      resolve({ code, info, finalMessage, stderr: stderrLines.join("") });
    });
    child.on("error", (e) => {
      rmSync(tmp, { recursive: true, force: true });
      resolve({ code: 1, info, finalMessage: "", stderr: String(e) });
    });
  });
}

// Codex `exec --json` emits these event types (v0.153):
//   thread.started { thread_id }
//   turn.started   {}
//   item.completed { item: { type:"agent_message"|"command_execution"|…, text? } }
//   turn.completed { usage: { input_tokens, cached_input_tokens, output_tokens, … } }
function harvest(ev, info, setFinal) {
  const type = ev.type || "";
  if (type === "thread.started" && ev.thread_id) info.sessionId = ev.thread_id;
  if (type === "turn.completed" && ev.usage) {
    const u = ev.usage;
    info.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    info.outcome = "completed";
  }
  if (type === "turn.failed" || type === "error") info.outcome = "error";
  if (type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
    setFinal(ev.item.text);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let auth;
  try {
    auth = assertSubAuth();
  } catch (e) {
    console.error(`🐾 tomcat: ${e.message}`);
    process.exit(2);
  }

  // Confirm the binary exists.
  try {
    execFileSync(CODEX, ["--version"], { stdio: "ignore" });
  } catch {
    console.error(`🐾 tomcat: \`${CODEX}\` not found on PATH`);
    process.exit(2);
  }

  console.error(
    `🐾 tomcat waking — harness: codex exec · model: ${args.model} · ` +
      `auth: ChatGPT sub (plan: ${auth.plan}) · cwd: ${args.cd}`,
  );
  if (!args.task && process.stdin.isTTY) {
    console.error("🐾 tomcat: give me a task (arg or stdin).");
    process.exit(2);
  }

  const t0 = Date.now();
  const { code, info, finalMessage, stderr } = await run(args);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n──────── tomcat answer ────────");
  console.log(finalMessage.trim() || "(no final message captured)");
  console.log("───────────────────────────────");
  console.error(
    `🐾 tomcat done in ${secs}s · outcome: ${info.outcome} · ` +
      `tokens: ${info.tokens ?? "?"} · session: ${info.sessionId ?? "?"} · ` +
      `exit: ${code}`,
  );
  if (code !== 0 && stderr.trim()) {
    console.error("stderr tail:\n" + stderr.split("\n").slice(-8).join("\n"));
  }
  process.exit(code === 0 ? 0 : 1);
}

main();
