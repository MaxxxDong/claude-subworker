import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { selectCodex, codexLaunchArgs, summarizeCodexStream } from "../lib/codex-backend.mjs";

test("Codex selection keeps model and effort, and refuses owned sandbox options", () => {
  const selected = selectCodex(["-m", "gpt-6-luna", "--effort=max", "-c", "tools.web_search=true"]);
  assert.equal(selected.model, "gpt-6-luna");
  assert.equal(selected.thinking, "max");
  assert.deepEqual(selected.args, ["-c", "tools.web_search=true"]);
  assert.equal(selectCodex([]).model, null);
  assert.equal(selectCodex([]).thinking, "high");
  assert.throws(() => selectCodex(["--sandbox", "danger-full-access"]), /owns Codex option --sandbox/);
  assert.throws(() => selectCodex(["--dangerously-bypass-approvals-and-sandbox"]), /owns/);
  assert.throws(() => selectCodex(["-c", "sandbox_mode=\"danger-full-access\""]), /owns Codex config sandbox_mode/);
  assert.throws(() => selectCodex(["--effort", "extreme"]), /effort/);
});

test("Codex launch args map modes to the native sandbox and resume by thread id", () => {
  const read = codexLaunchArgs({ args: [], prompt: "task", mode: { model: "gpt-6-luna", thinking: "max", readOnly: true }, systemPrompt: "scope" });
  assert.deepEqual(read.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  assert.ok(read.includes('sandbox_mode="read-only"'));
  assert.ok(!read.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(read.includes('approval_policy="never"'));
  assert.ok(read.includes('model_reasoning_effort="max"'));
  assert.ok(read.includes('developer_instructions="scope"'));
  assert.equal(read.at(-1), "task");
  const write = codexLaunchArgs({ args: [], prompt: "more", mode: { model: null, thinking: "high", readOnly: false }, conversationId: "thread-1" });
  assert.deepEqual(write.slice(0, 3), ["exec", "resume", "thread-1"]);
  assert.ok(write.includes('sandbox_mode="workspace-write"'));
  assert.ok(write.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(!write.includes("-m"));
});

async function summarize(frames) {
  let settled = 0;
  const attentions = [];
  const result = await summarizeCodexStream(Readable.from(frames.map((frame) => JSON.stringify(frame) + "\n")), {
    onActivity() {}, onAttention(category, detail) { attentions.push({ category, detail }); }, onSettled() { settled += 1; }, classifyAttention() { return null; },
  });
  return { result, settled, attentions };
}

test("Codex stream collects thread, tools, final message and usage; warning items do not fail", async () => {
  const { result, settled } = await summarize([
    { type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 4 unrecognized configuration settings." } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "checking" } },
    { type: "item.started", item: { id: "item_2", type: "command_execution", command: "ls", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "ls", exit_code: 0, status: "completed" } },
    { type: "item.started", item: { id: "item_3", type: "command_execution", command: "false", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_3", type: "command_execution", command: "false", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "item_4", type: "file_change", changes: [], status: "completed" } },
    { type: "item.completed", item: { id: "item_5", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } },
  ]);
  assert.equal(settled, 1);
  assert.equal(result.conversationId, "thread-1");
  assert.equal(result.lastAssistant.text, "done");
  assert.equal(result.lastAssistant.error, null);
  assert.equal(result.backendStatus, "SUCCESS");
  assert.equal(result.assistantCalls, 2);
  assert.deepEqual(result.tools, [{ name: "shell", count: 2, errorCount: 1 }, { name: "file_change", count: 1, errorCount: 0 }]);
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.warnings.length, 1);
});

test("Codex turn.failed settles with the provider message; reconnect errors raise retry attention", async () => {
  const { result, settled, attentions } = await summarize([
    { type: "thread.started", thread_id: "thread-2" },
    { type: "turn.started" },
    { type: "error", message: "Reconnecting... 2/5" },
    { type: "error", message: JSON.stringify({ type: "error", status: 400, error: { message: "model is not supported" } }) },
    { type: "turn.failed", error: { message: JSON.stringify({ type: "error", status: 400, error: { message: "model is not supported" } }) } },
  ]);
  assert.equal(settled, 1);
  assert.equal(result.backendStatus, "ERROR");
  assert.equal(result.lastAssistant.stopReason, "error");
  assert.equal(result.lastAssistant.error, "model is not supported");
  assert.ok(attentions.some((entry) => entry.category === "provider_retry"));
  assert.ok(result.providerRetryCount >= 1);
});
