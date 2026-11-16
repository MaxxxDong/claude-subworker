import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createStdoutScan, isCorruptedJson } from "./stream-scan.mjs";
import { nextRetryCount, parseRetryAttempt } from "./retry-policy.mjs";

const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const CODEX_PROFILES = { efforts: CODEX_EFFORTS, defaultEffort: "high", defaultModel: null };

// Subworker owns session, sandbox, output and working-directory selection;
// the Codex sandbox is the enforcement boundary, so callers cannot widen it.
const OWNED = new Set([
  "--json", "--cd", "-C", "--sandbox", "-s", "--output-last-message", "-o", "--ephemeral", "--worktree",
  "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--last", "--all", "resume", "fork",
]);

// Environment injected by a Codex host session. A worker is an independent
// Codex process, so it must not inherit the scheduling thread or its sandbox.
export const CODEX_HOST_ENV = ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI", "CODEX_MANAGED_BY_NPM"];

export function selectCodex(args) {
  let model = CODEX_PROFILES.defaultModel;
  let thinking = CODEX_PROFILES.defaultEffort;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (OWNED.has(name)) throw new Error(`Subworker owns Codex option ${name}`);
    if (["--model", "-m", "--effort", "--thinking", "--reasoning-effort"].includes(name)) {
      const value = separator < 0 ? args[++i] : argument.slice(separator + 1);
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${name}`);
      if (name === "--model" || name === "-m") model = value;
      else thinking = value;
      continue;
    }
    if ((name === "-c" || name === "--config") && /^(sandbox_mode|sandbox_workspace_write|approval_policy|model_reasoning_effort)\b/.test(args[i + 1] ?? "")) {
      throw new Error(`Subworker owns Codex config ${args[i + 1].split("=", 1)[0]}`);
    }
    rest.push(argument);
  }
  if (!CODEX_EFFORTS.includes(thinking)) throw new Error(`Codex effort must be one of: ${CODEX_EFFORTS.join(", ")}`);
  return { args: rest, provider: "codex", model, thinking };
}

export function codexLauncher() {
  if (process.env.CODEX_WORKER_LAUNCHER) return process.env.CODEX_WORKER_LAUNCHER;
  const local = join(homedir(), ".local", "bin", "codex");
  return existsSync(local) ? local : "codex";
}

function toml(value) {
  return JSON.stringify(String(value));
}

// read → OS-enforced read-only sandbox (no writes, no network).
// write/in-place → workspace-write on the task root (Codex also allows $TMPDIR), network allowed.
export function codexLaunchArgs({ args, prompt, mode, conversationId = null, systemPrompt }) {
  const readOnly = mode.readOnly === true;
  return [
    "exec",
    ...(conversationId ? ["resume", conversationId] : []),
    "--json",
    "--skip-git-repo-check",
    "-c", `sandbox_mode=${toml(readOnly ? "read-only" : "workspace-write")}`,
    ...(readOnly ? [] : ["-c", "sandbox_workspace_write.network_access=true"]),
    "-c", `approval_policy=${toml("never")}`,
    ...(mode.model ? ["-m", mode.model] : []),
    "-c", `model_reasoning_effort=${toml(mode.thinking)}`,
    ...(systemPrompt ? ["-c", `developer_instructions=${toml(systemPrompt)}`] : []),
    ...args,
    prompt,
  ];
}

function toolEntry(tools, name) {
  let tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    tool = { name, count: 0, errorCount: 0 };
    tools.push(tool);
  }
  return tool;
}

function toolName(item) {
  if (item.type === "command_execution") return "shell";
  if (item.type === "file_change") return "file_change";
  if (item.type === "web_search") return "web_search";
  if (item.type === "mcp_tool_call") return `mcp:${item.server ?? "unknown"}.${item.tool ?? "unknown"}`;
  return null;
}

function itemFailed(item) {
  if (item.status === "failed" || item.status === "declined") return true;
  if (item.type === "command_execution" && Number.isFinite(item.exit_code) && item.exit_code !== 0) return true;
  return Boolean(item.error);
}

function errorText(value) {
  const raw = typeof value === "string" ? value : (value?.message ?? "");
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error?.message ?? parsed?.message ?? raw);
  } catch {
    return String(raw);
  }
}

const RECONNECT = /reconnecting|retrying|stream disconnected|retry\s+\d+/i;

export async function summarizeCodexStream(stream, { onActivity, onAttention, onSettled, classifyAttention }) {
  const summary = {
    settled: false,
    lastAssistant: null,
    usage: {},
    assistantCalls: 0,
    tools: [],
    playwrightUsed: false,
    conversationId: null,
    structuredOutput: null,
    backendStatus: null,
    backendTurns: null,
    backendDeniedActionCount: 0,
    providerRetryCount: null,
    warnings: [],
  };
  let lastText = "";
  let lastError = null;
  const started = new Set();
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const scan = createStdoutScan({ classifyAttention });
  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      const hit = scan.noteLine(line);
      if (hit) onAttention(hit.category, hit.detail);
      if (isCorruptedJson(line)) {
        throw new Error(`Corrupted protocol JSON: malformed JSON frame; line: ${String(line ?? "").trim().slice(0, 200)}`);
      }
      continue;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`Corrupted protocol frame: expected non-null object, got ${event === null ? "null" : Array.isArray(event) ? "array" : typeof event}`);
    }
    scan.noteSuccess();
    if (event.type === "thread.started") {
      summary.conversationId = event.thread_id ?? summary.conversationId;
      onActivity({ type: "backend_init" });
      continue;
    }
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const item = event.item ?? {};
      const id = String(item.id ?? "item");
      if (item.type === "error") {
        // Codex reports config and metadata warnings as error items; they do not end the turn.
        if (event.type === "item.completed") summary.warnings.push(String(item.message ?? "").slice(0, 500));
        onActivity({ type: "codex_warning" });
        continue;
      }
      if (item.type === "agent_message") {
        if (event.type === "item.completed") {
          summary.assistantCalls += 1;
          lastText = String(item.text ?? "");
          onActivity({ type: "message_end", message: { role: "assistant" } });
        } else onActivity({ type: "codex_message_delta" });
        continue;
      }
      const name = toolName(item);
      if (!name) {
        onActivity({ type: `codex_${item.type ?? "item"}` });
        continue;
      }
      if (!started.has(id)) {
        started.add(id);
        toolEntry(summary.tools, name).count += 1;
        onActivity({ type: "tool_execution_start", toolCallId: id, toolName: name });
      }
      if (event.type === "item.completed") {
        const isError = itemFailed(item);
        if (isError) toolEntry(summary.tools, name).errorCount += 1;
        if (item.status === "declined") summary.backendDeniedActionCount += 1;
        started.delete(id);
        onActivity({ type: "tool_execution_end", toolCallId: id, toolName: name, isError });
      }
      continue;
    }
    if (event.type === "error") {
      const message = errorText(event.message ?? event.error);
      if (RECONNECT.test(message)) {
        summary.providerRetryCount = nextRetryCount(summary.providerRetryCount, parseRetryAttempt(event));
        onAttention("provider_retry", `Codex ${message.slice(0, 300)}`);
      } else lastError = message;
      onActivity({ type: "codex_error" });
      continue;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      const error = event.type === "turn.failed" ? (errorText(event.error) || lastError || "Codex turn failed") : null;
      summary.settled = true;
      summary.backendStatus = error ? "ERROR" : "SUCCESS";
      summary.backendTurns = 1;
      summary.usage = { ...(event.usage ?? {}) };
      summary.lastAssistant = {
        provider: "codex",
        model: null,
        stopReason: error ? "error" : "stop",
        error,
        usage: event.usage ?? null,
        text: lastText,
      };
      const category = classifyAttention(error);
      if (category) onAttention(category, error);
      onActivity({ type: "agent_settled" });
      onSettled();
      continue;
    }
    onActivity({ type: `codex_${event.type ?? "event"}` });
  }
  return summary;
}
