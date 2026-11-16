# claude-subworker

在 Claude Code / Codex 里把实现、修复、审查、测试、检索或调研任务派给其他模型和运行时，由主代理审查结果。

支持的后端：

| 后端 | 说明 |
|---|---|
| Pi（默认） | DeepSeek / GLM / Qwen / Grok 等，按 Pi 的 provider 配置 |
| Codex CLI | GPT 系列，唯一带操作系统级沙箱的后端 |
| Agy | Gemini 系列 |
| Grok Build | Grok |
| Muse Code | muse-wonder |
| Claude Code | 独立 Claude Code 进程，可经 CommandCode 桥接跑非 Anthropic 模型 |

每个运行由后台 supervisor 托管，支持 `dispatch` / `wait` / `continue` / `steer` / `cancel` / `status` / `diagnose` / `cleanup`；write 模式在独立 Git worktree 里改，产出 `changes.patch` 供审查后再合入。

## 目录

- `subworker/`：核心实现（Codex 技能），Node.js，零外部依赖。
- `claude-subworker/`：Claude Code 宿主的薄包装，调用核心实现，只做宿主适配（清理 `CLAUDE*` 环境变量、自动填 `--consumer`）。

## 安装（macOS）

```bash
git clone https://github.com/MaxxxDong/claude-subworker.git
cp -R claude-subworker/subworker ~/.codex/skills/subworker
cp -R claude-subworker/claude-subworker ~/.claude/skills/claude-subworker
```

需要 Node.js 22+（开发时用 24），以及你要用的后端各自的 CLI（`pi`、`codex`、`agy`、`grok`、`muse`、`claude`）并已登录。

核心实现不在默认位置时，用 `SUBWORKER_REAL_BIN` 指向 `subworker/bin/subworker`。

## 用法

```bash
SW=~/.claude/skills/claude-subworker/bin/subworker
$SW profiles          # 查看后端、模型与默认强度
$SW help              # 语法
$SW dispatch --backend codex --run-id review-1 --mode read --workdir /path/to/repo -- \
  --effort high "审查这个仓库的错误处理，列出问题和位置。"
$SW wait --run-id review-1 --timeout 540
```

详细规则见 [claude-subworker/SKILL.md](claude-subworker/SKILL.md) 和 [subworker/SKILL.md](subworker/SKILL.md)。

## 安全提示

除 Codex 后端外，read 模式和写入边界只靠提示约束，不是强制隔离。如果你的 Claude / Agy 设置为跳过权限确认，worker 也会跟着跳过。涉及敏感目录时请把写入范围写死并在审查时核对。

## 测试

```bash
cd subworker && node --test tests/*.test.mjs
```

## 许可

MIT
