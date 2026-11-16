---
name: claude-subworker
description: 仅限 Claude Code 宿主。把实现、修复、审查、测试、仓库检索或网络调研派给 Claude 之外的模型/运行时（Codex CLI 上的 GPT、Pi 上的 DeepSeek/GLM/Qwen/Grok、Agy 上的 Gemini、Grok Build、Muse Code 上的 muse-wonder），或派给独立的 Claude Code 进程（含 CommandCode 桥接的非 Anthropic 模型），由我审查结果。用户点名 subworker、指定上述后端或模型、要求跨模型家族交叉审查时使用；普通的 Claude 子任务用内置 Agent 工具。
---

# Claude Subworker

这是 Codex 版 `subworker` 在 Claude Code 下的适配入口，核心实现只有一份：`~/.codex/skills/subworker/`。统一通过包装脚本调用：

```bash
SW=~/.claude/skills/claude-subworker/bin/subworker
```

包装脚本只做两件宿主适配：`dispatch`/`continue`/`steer` 前清掉宿主注入的 `CLAUDE*` 环境变量，让 Claude 后端成为独立进程，而不是挂到当前桌面会话下的子会话；`wait` 未给 `--consumer` 时自动使用 `claude-<当前会话ID>`。其余参数原样透传。`$SW profiles` 查看后端、模型与默认强度，`$SW help` 查看语法。

## 先判断：Agent 工具还是 subworker

- **用内置 Agent 工具**：子任务用 Claude 模型就够（检索用 `Explore`，实现用 `general-purpose`，需要隔离时加 `isolation: "worktree"`）。它更轻，结果直接回到对话里。
- **用 subworker**：需要非 Claude 模型（便宜的批量工作、换一个模型家族做交叉审查、Gemini/Grok 特长）、需要在我结束本轮后继续运行的长任务，或需要托管 worktree 并产出 `changes.patch` 供审查。
- `--backend claude` 只在用户明确要一个独立的 Claude Code 进程时用，例如 `--provider commandcode` 让 Claude Code 的工具链跑 DeepSeek/GLM/Qwen 等模型。普通 Claude 子任务不要绕这条路。
- 用户已指定的后端、模型、强度原样保留；示例里的模型不覆盖用户的选择。用户没指定、又会产生明显费用，或者要把项目代码发给第三方模型供应商时，派发前用一句话确认后端和模型。

## 工作区与交付物

- `--mode read --workdir DIR`：只读检查。Pi 提供读工具和受提示约束的 shell；Agy 用原生 `plan`；Claude 用 `plan` 加只读系统提示。**这些都不是操作系统级沙箱。** 只有 Codex 后端用原生 `read-only` 沙箱真正强制只读（同时禁网）。
- `--mode write --source DIR`：在托管的 detached Git worktree 里改，基线包含已暂存、未暂存和未被忽略的未跟踪文件。源目录有未提交改动也没关系，worker 只写 worktree 或本次运行的 `TMPDIR`。
- `--mode in-place --workdir DIR`：直接写指定目录（也支持非 Git 的文档目录）。并发写入时给每个 worker 分配不同目录，或划清不重叠的文件所有权。
- 任务说明要写清：范围、必要参考、写入所有权、验收标准、停止点。必需的输入尽量放进分配的工作区，不要为了迁就放错位置的输入去放宽权限。
- **长文档和代码写成文件**，放在已授权的写入区；最终回复只要路径、简短摘要、做过的检查和遗留问题。除非用户或真实的下游消费方需要，不要求一次 JSON 吐出整个文件。
- worker 用它自己运行时里的编辑工具。不要在任务里要求它用我这边的 Edit/Write 等工具（它没有）；如果某个明确要求的方法它做不到，要求它报告阻塞，不许自行替代。

## 派发与跟进（在 Claude Code 里）

- 用 Bash 工具执行，不需要沙箱提权。`dispatch` 会在后台启动 supervisor 后立即返回。
- 非平凡的提示词先用 Write 写成文件（放 scratchpad 或工作区），再以带引号的参数传入，避免 shell 解释：

```bash
SW=~/.claude/skills/claude-subworker/bin/subworker
$SW dispatch --backend agy --run-id draft-1 --mode in-place --workdir /absolute/assigned-dir -- \
  --model gemini-3.8-flash-high --effort high "$(< /absolute/task.md)"
$SW wait --run-id draft-1 --timeout 540
$SW continue --run-id draft-1 -- "按审查意见逐条修正后停止。"
```

- **等待**：Bash 单次最长 600 秒，所以前台 `wait --timeout` 不超过 540，Bash 的 `timeout` 设为 600000。预计要跑很久的任务，改用 Bash `run_in_background: true` 执行不带超时的 `$SW wait --run-id ...`，结束时会自动通知我，期间可以先做别的。不要用 sleep 循环轮询。
- 一次 `wait` 可以带多个 `--run-id`，返回 `{ results, alerts, pending }`；之后只对 pending 的 ID 再等。最多 10 个并发运行，互不依赖的任务在同一条消息里一起派发。
- 需要多个独立调用方共享同一组运行时，才显式传 `--consumer`；否则交给包装脚本的默认值。

| 后端 | 选择与能力 | 跟进 |
|---|---|---|
| Pi（默认） | `--provider ID --model ID --thinking LEVEL`；可选 `--capability docs\|lens\|context\|browser`；加载 Pi 自己配置的技能 | `continue`；主动 `steer` 需要派发时加 `--live` |
| Agy | 必须给 `--model ID --effort low\|medium\|high`（默认 high）；write/in-place 为 `accept-edits`；使用原生技能/MCP/插件 | `continue`；不支持 live、steer 和 capability |
| Claude Code | `--provider commandcode\|native --model ID --effort LEVEL`；CommandCode 用临时桥接和 Pi 的 key；write=`auto`，in-place=`acceptEdits`；默认禁用内部编排，除非加 `--allow-orchestration` | `continue`；不支持 live、steer 和 capability |
| Grok Build | `--backend grok --model grok-4.6 --effort xhigh`（即默认值）；使用原生技能/MCP/插件；运行时自动带 bypass | `continue` 续接同一个会话；不支持 live、steer 和 capability |
| Codex CLI | `--backend codex -m gpt-6-luna --effort max` 等（强度 minimal–max，默认 high；不给模型则用 Codex 配置的默认模型）；沿用本机 Codex 登录态和它自己的技能/MCP；**真正的操作系统级沙箱**：read=`read-only`（不能写、不能联网），write/in-place=`workspace-write` 且允许联网；沙箱和审批参数归 subworker 管，不能从外部放宽 | `continue` 续接同一个 Codex 线程；不支持 live、steer 和 capability；cleanup 后 Codex 自己的会话记录仍保留在 `~/.codex/sessions` |
| Muse Code | `--backend muse --model muse-wonder-full-1.0 --effort high`（即默认值，强度 none–ultra）；沿用本机 `muse login`，加载 `~/.agents/skills` 里的用户技能（含 cross-domain-task-design）；**保留 Muse 自带的操作系统级沙箱**：只能写工作区和临时目录，write/in-place 可联网，read 另加 `--disable-write` 并断网（工作区内的 shell 写入仍只靠提示约束）；审批 never、审批裁判关；启动时 stderr 的诊断行不计告警 | `continue` 续接同一会话（`muse exec --session-id`）；不支持 live、steer 和 capability |

## 审查与恢复

- `success` 只代表运行正常结束且有非空回复，**不等于任务验收通过**。我要亲自读实际文件、跑相关检查；接口要求 JSON 时校验 JSON。
- write 模式的改动不会自动进入用户源目录。我先读 `changes.patch`，确认后再用 `git apply` 合入，或者按用户的意思处理。`$SW status --run-id ID` 会给出 worktree、会话目录等路径。
- 失败的运行也可能留下有用的文件或 `finalText`，重试前先看，不丢弃，也不因为文本完整就把原生 `ERROR` 当成功。`continue` 会保留对话和历史，但重置当前的错误和输出字段。
- `$SW diagnose --run-id ID` 查看配置、告警和重试建议。`providerRetryCount` 是观测到的原生 CLI 重试次数，`null` 表示未知。认证、配置、不支持参数这类问题先修再重试；CLI 正在重试瞬时错误时继续等，不要重复派发。
- 停止运行用 `cancel --run-id ID --reason "..." --timeout 30`，不要直接 kill supervisor。审查过 `result.json` 和 `changes.patch`，并且需要的结果已经合入或保存后，再执行 `cleanup --reviewed yes --run-id ID` 清理 worktree、会话和临时资源。带结果的运行不会被自动删除。

## 运行边界

- Codex 后端是唯一由操作系统强制隔离的后端：需要"真只读"审查或严格限制写入范围时优先考虑它。但 read 模式同时禁止联网，要联网调研就得用 in-place 并把写入目录限定好。
- 本机 Claude 设置是 `permissions.defaultMode=bypassPermissions`，所以 Claude 后端会自动带上 `--dangerously-skip-permissions`（记录在 `backendArgs` 和 diagnose 里）。Agy 的 `toolPermission=always-proceed` 同理。Grok 在任何模式下都自动 bypass。也就是说，read 模式和任务边界只靠提示约束，不是强制隔离；涉及敏感目录时要把写入范围写死，并在审查时核对。未经授权不改这些全局设置。
- 默认不设硬超时和空闲超时；Agy 后端例外：硬超时 3 小时、空闲超时 30 分钟（Agy 会在重试接口或写完最后一轮后挂着不退）。显式传 `--hard-timeout`、`--idle-timeout` 以显式值为准，传 0 即关闭。Agy 一轮因为传输中断或空闲超时结束时，会在同一会话里自动续跑一次（回执里 `autoResume: true`，前一轮记在 `turns`），`wait` 会等到续跑结束；续跑再失败就按失败收。不想自动续跑设环境变量 `SUBWORKER_AGY_AUTO_RESUME=0`。启动提醒 60 秒；静默提醒 600 秒；无工具进展提醒在 write/in-place 下为 600 秒，read 下关闭。这些只是软提醒，不会取消运行，设为 0 即关闭。确有需要才设 `--hard-timeout` 或 `--idle-timeout`。
- 环境变量用 `SUBWORKER_*`（兼容旧的 `PI_WORKER_*`）；`SUBWORKER_REAL_BIN` 可以覆盖包装脚本调用的底层实现。运行状态默认存在 `~/Library/Application Support/pi-worker/runs`，与 Codex 共用，可用 `SUBWORKER_STATE_ROOT` 覆盖。审查后的 cleanup 在没有其他 worker 活动时，会顺带做共享缓存的 LRU 维护（上限 20 GiB）。
- 底层实现归 Codex 版维护；这里只改宿主适配。要改行为，先改 `~/.codex/skills/subworker`，再检查本文件是否需要同步。
