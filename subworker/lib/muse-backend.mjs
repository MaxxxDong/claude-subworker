import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createStdoutScan, isCorruptedJson } from "./stream-scan.mjs";
import { nextRetryCount, parseRetryAttempt } from "./retry-policy.mjs";

const MUSE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const MUSE_PROFILES = { efforts: MUSE_EFFORTS, defaultEffort: "high", defaultModel: "muse-wonder-full-1.0" };

// Subworker owns output format, workspace, session and approval/sandbox selection.
const OWNED = new Set([
  "--json", "--workspace", "--session-id", "--prompt-file", "--yolo", "--approval-mode", "--approval-judge",
  "--disable-approval", "--disable-sandbox", "--trust-workspace", "--disable-write",
  "--disable-request-user-input", "--user-input-auto-resolve", "-w", "--worktree", "--worktree-existing",
  "--allow-workspace-switch", "--provider", "exec", "resume",
]);

export function selectMuse(args) {
  let model = MUSE_PROFILES.defaultModel;
  let thinking = MUSE_PROFILES.defaultEffort;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (OWNED.has(name)) throw new Error(`Subworker owns Muse option ${name}`);
    if (["--model", "-m", "--effort", "--thinking", "--reasoning-effort"].includes(name)) {
      const value = separator < 0 ? args[++i] : argument.slice(separator + 1);
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${name}`);
      if (name === "--model" || name === "-m") model = value;
      else thinking = value;
      continue;
    }
    rest.push(argument);
  }
  if (!MUSE_EFFORTS.includes(thinking)) throw new Error(`Muse effort must be one of: ${MUSE_EFFORTS.join(", ")}`);
  return { args: rest, provider: "meta", model, thinking };
}

export function museLauncher() {
  if (process.env.MUSE_WORKER_LAUNCHER) return process.env.MUSE_WORKER_LAUNCHER;
  const local = join(homedir(), ".local", "bin", "muse");
  return existsSync(local) ? local : "muse";
}

// The Muse OS sandbox stays on (writes limited to the workspace and temp dirs); headless runs cannot
// answer prompts, so approval is "never" and the approval judge is off. write/in-place get network;
// read disables non-shell writes and network, and relies on the read-only prompt for shell writes.
// Continue passes the previous session id back to `muse exec --session-id`.
export function museLaunchArgs({ args, prompt, mode, conversationId = null, workdir, systemPrompt }) {
  const readOnly = mode.readOnly === true;
  return [
    "exec", "--json", "--trust-workspace", "--approval-mode", "never", "--approval-judge", "off",
    "--disable-request-user-input",
    "--workspace", workdir,
    "--sandbox-network", readOnly ? "restricted" : "enabled",
    ...(readOnly ? ["--disable-write"] : []),
    ...(conversationId ? ["--session-id", conversationId] : []),
    "--model", mode.model, "--reasoning-effort", mode.thinking,
    ...args,
    systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
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

const RECONNECT = /reconnecting|retrying|stream disconnected|retry\s+\d+|rate.?limit|overloaded/i;

export async function summarizeMuseStream(stream, { onActivity, onAttention, onSettled, classifyAttention }) {
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
  let deltaText = "";
  let model = null;
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
    if (event.stream?.kind === "session" && event.stream.id && !summary.conversationId) {
      summary.conversationId = event.stream.id;
      onActivity({ type: "backend_init" });
    }
    const payload = event.payload ?? {};
    const type = String(event.payload_type ?? payload.kind ?? "event");
    if (type === "run.model.configured") {
      model = payload.model_id ?? model;
      onActivity({ type: "muse_model" });
      continue;
    }
    if (type === "run.output.delta") {
      deltaText += String(payload.text ?? "");
      onActivity({ type: "muse_message_delta" });
      continue;
    }
    if (type === "tool.result") {
      const facts = payload.correlation_facts ?? {};
      const name = String(facts.tool_name ?? "tool");
      const isError = facts.outcome != null && facts.outcome !== "success";
      const tool = toolEntry(summary.tools, name);
      tool.count += 1;
      if (isError) tool.errorCount += 1;
      if (facts.outcome === "denied" || facts.outcome === "rejected") summary.backendDeniedActionCount += 1;
      const id = String(payload.call_id ?? `${name}-${tool.count}`);
      onActivity({ type: "tool_execution_start", toolCallId: id, toolName: name });
      onActivity({ type: "tool_execution_end", toolCallId: id, toolName: name, isError });
      continue;
    }
    // Model-call retries arrive as task lifecycle events: "opening meta model stream attempt N/10"
    // status messages and "failed" events whose reason is a transport/stream error.
    const lifecycle = payload.event ?? {};
    const attempt = /model stream attempt (\d+)\s*\/\s*(\d+)/i.exec(String(lifecycle.message ?? ""));
    if (attempt && Number(attempt[1]) > 1) {
      summary.providerRetryCount = Math.max(summary.providerRetryCount ?? 0, Number(attempt[1]) - 1);
      onAttention("provider_retry", `Muse ${String(lifecycle.message).slice(0, 300)}`);
    }
    if (lifecycle.kind === "failed" && /transport|stream|provider|decode|timeout/i.test(String(lifecycle.reason ?? ""))) {
      summary.providerRetryCount = (summary.providerRetryCount ?? 0) + 1;
      onAttention("provider_retry", `Muse ${String(lifecycle.reason).slice(0, 300)}`);
    }
    if (/usage/i.test(type) && payload && typeof payload === "object") {
      summary.usage = { ...summary.usage, ...(payload.usage ?? payload) };
      onActivity({ type: "muse_usage" });
      continue;
    }
    if (/retry|error/i.test(type)) {
      const message = String(payload.message ?? payload.error ?? payload.text ?? type);
      if (RECONNECT.test(message) || /retry/i.test(type)) {
        summary.providerRetryCount = nextRetryCount(summary.providerRetryCount, parseRetryAttempt(payload));
        onAttention("provider_retry", `Muse ${message.slice(0, 300)}`);
      } else summary.warnings.push(message.slice(0, 500));
      onActivity({ type: "muse_error" });
      continue;
    }
    if (type.startsWith("run.terminal")) {
      const terminal = String(payload.terminal ?? type.split(".").pop());
      const ok = terminal === "completed";
      const error = ok ? null : String(payload.reason ?? payload.text ?? `Muse run ${terminal}`);
      summary.settled = true;
      summary.backendStatus = ok ? "SUCCESS" : "ERROR";
      summary.backendTurns = 1;
      summary.assistantCalls += 1;
      summary.lastAssistant = {
        provider: "meta",
        model,
        stopReason: ok ? "stop" : "error",
        error,
        usage: null,
        text: String(payload.text ?? deltaText),
      };
      const category = classifyAttention(error);
      if (category) onAttention(category, error);
      onActivity({ type: "agent_settled" });
      onSettled();
      continue;
    }
    onActivity({ type: `muse_${payload.kind ?? "event"}` });
  }
  return summary;
}

// Muse prints startup diagnostics on stderr (workspace root, trust, skill catalog and duplicate-id
// warnings). They carry paths such as /private/tmp/claude-501 that the generic patterns misread as
// HTTP 501, so they are dropped before attention classification; everything else is classified as-is.
const MUSE_DIAGNOSTIC = /^muse:\s+(?:workspace root:|workspace trust:|Skills:|\s|`skills_catalog`|Run `muse skills)/;

export function museStderrClassifier(classifyAttention) {
  return (value) => classifyAttention(String(value ?? "").split("\n").filter((line) => !MUSE_DIAGNOSTIC.test(line)).join("\n"));
}
