# dsh-shell-cmd

DeepSeek Harness（dsh）插件：在输入框输入 `/cmd <终端命令>`，**先执行命令**，再把「命令 + 输出」一起发给模型，并让这次输入在对话里以**终端卡片**渲染，而不是一段纯文本 prompt。

对标 Claude Code 的 `!<command>` 能力，区别是这里会把命令与输出明确交给模型，并要求模型据此回复。

## 效果

```
你： /cmd git status --short

  ⬢ 终端命令  $ git status --short              [完成]
  ┌────────────────────────────────────────────────────┐
  │ M src/App.tsx                                      │
  │ ?? tests/new.test.ts                               │
  └────────────────────────────────────────────────────┘
  M src/App.tsx · ?? tests/new.test.ts        [展开全部 2 行] [复制命令与输出]

模型：当前工作区有 1 个已修改文件和 1 个未跟踪文件……
```

- 命令卡片：等宽字体、`$` 提示符、状态胶囊（执行中 / 退出码 / 超时 / 取消）、可展开的长输出、复制按钮。
- 模型输入：一条 user 消息，正文包含「用户手动执行了此命令」、命令原文、cwd、退出状态与 stdout/stderr。
- 历史回放：卡片从 `command/run` + `command/done` 折叠出的 `CommandNode` 重建，重开会话/刷新后仍在。

## 使用

1. 在输入框键入 `/`，从命令菜单选择 **cmd**（或直接输入 `/cmd `），菜单会显示命令说明与输入提示。
2. 在 `/cmd ` 之后写终端命令，回车提交。命令在**当前会话工作目录**执行。
3. 命令结束后，模型会自动收到命令与输出并给出回复。

示例：

```
/cmd ls -la
/cmd git log --oneline -5
/cmd cat package.json
/cmd npm test
```

### 行为细节

| 情况 | 表现 |
| --- | --- |
| 命令退出码非 0 | 卡片显示红色 `退出 N` 胶囊；输出照常发给模型（非零退出是结果，不是插件错误） |
| 命令超时 | 默认 120s 后杀掉进程，卡片显示 `已超时`，输出与超时标记发给模型 |
| 执行器报错（如无法启动） | 卡片显示错误文本，**不会**触发模型轮次 |
| 输出过长 | 单流最多读取 256 KiB；卡片与模型文本各自截断到 24k 字符并标注省略量 |
| 会话正在运行 | 命令照常执行；命令消息经 `agent.followup()` 排队，等当前轮次结束再送达 |
| 取消 | 命令执行绑定 UI 请求的取消信号；被取消时不向模型发送任何内容 |

### 安全说明

`/cmd` 是**人类显式输入**的命令，等价于用户自己在终端执行，因此默认**不**套用模型工具的 sandbox 策略（不传 `sandboxPolicy`）。它不是模型发起的工具调用；模型只能看到执行结果，不能借此执行命令。

## 安装

本地目录安装（开发中）：

```
plugin_manager action=install_bundle target=/Users/lzx/Documents/GitHub/dsh-shell-cmd
```

安装后 bundle 会写入当前 profile 的 `package.json`（`dsh.profile.bundles`）并插入一行 Host 插件：

```yaml
- insert:
    - id: shell-cmd
      name: dsh-shell-cmd
```

Host 行 / Client 半端分别是 `index.js` 与 `client.js`，由 `package.json` 的 `dsh.bundle.patch` 与 `dsh.client` 声明。

## 架构

```
用户输入 /cmd <cmd>
        │
        ▼
[Host] commands 服务解析并调用 handler
        │  1. ctx.shell.resolve / execute（cwd=会话工作目录，前台等待，带超时与取消）
        │  2. 组装正文：stdout + [stderr] + 状态标记
        │  3. agent.followup(user 消息：命令 + cwd + exit + 输出)  ← 模型据此回复
        ▼
[会话日志] command/run + command/done（log-only，不进模型历史）
        │
        ▼
[Client] conversation.chat.commandview，key = "cmd"  →  终端卡片
```

关键契约：

- Host 半端导出 `{ name, inject, apply }`，`inject = ['commands', 'shell', 'workingDirectory']`；缺失任一服务时插件保持 inactive 而不是抛错。
- **不静态 import 任何 `@deepseek-ai/*` 核心包**：本地链接安装的插件在工作区内无法解析 dsh 安装内的包。UserMessage 按 `createUserMessage()` 的等价结构就地构造（`id` / `role` / `content` / `source`）。
- Client 半端是 `window.__ModuleLoader__` 的懒工厂 classic script，只能 `require('react')`，无 JSX；样式经 `<style data-plugin-css>` 注入并在 `ctx.effect` 中清理。
- 卡片注册在 `conversation.chat.commandview`（按命令名键控、`replaceRisk: none` 的公开扩展点），不替换任何内置渲染器。
- 所有颜色走 `--dsw-alias-*` 主题令牌，明暗主题与主题切换自动跟随。

### 模型看到的输入（示意）

```
The user ran the following shell command from the DSH composer (/cmd). Respond to the user
based on the command and its output; the command was not run by you.

$ git status --short
cwd: /Users/me/project
exit: 0

 M src/App.tsx
?? tests/new.test.ts
```

消息 `source.kind = "shell-command"`。UI 上它表现为一条**默认折叠**的“Execution requested”turn-trigger 通知，正文只在用户主动展开时显示——可见的输入表达始终是上方的终端卡片。

## 可调常量

`index.js` 顶部导出：

| 常量 | 默认值 | 含义 |
| --- | --- | --- |
| `DEFAULT_TIMEOUT_MS` | `120000` | 单条命令超时（毫秒） |
| `DEFAULT_MAX_OUTPUT_CHARS` | `24000` | 卡片与模型文本各自保留的最大字符数 |
| `STDOUT_MAX_BYTES` | `262144` | 执行器侧单流读取上限 |

当前版本未导出 `Config`（避免依赖 schemastery）；`apply(ctx, config)` 仍会读取行配置中的 `timeoutMs` / `maxOutputChars`（若 Loader 透传）。

## 开发与验证

```bash
npm run check   # node --check index.js && node --check client.js
npm test        # node --test tests/  （Host 半端纯函数与执行路径单测）
npm run verify  # check + test
```

## 已知边界

- 卡片渲染只在 **Web / Desktop 的 Chat 视图**生效；纯文本入口（CLI、ACP、JSON-RPC）没有 slash 命令表面，也就没有 `/cmd`。
- 会话全空的“新会话”在第一条命令时可能先记录 `command/run` 再激活会话；卡片随会话激活出现（与内置命令行一致）。
- 输出上限是为了保护会话日志与模型上下文；需要完整输出时请改用重定向到文件再 `/cmd cat <file>`。
- 不提供 shell 持久化：每次 `/cmd` 都是独立的 `bash -c` 会话，`cd` 不会跨调用保留。

## License

MIT
