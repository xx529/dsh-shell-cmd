# dsh-shell-cmd · 仓库级 Agent 指南

本文件是给在本仓库工作的 AI/人类协作者的工程约定。**用户级规则（`~/.dsh/AGENTS.md`）优先于本文件**；本文件只补充仓库特有的事实与流程。

---

## 1. 项目是什么

一个 DeepSeek Harness（dsh）插件：

- 用户在输入框输入 `/cmd <终端命令>`；
- Host 先执行命令，把「命令 + cwd + 退出码 + stdout/stderr」作为一条 user 消息交给模型；
- 对话里把这次输入渲染成**终端卡片**（`conversation.chat.commandview`，key=`cmd`）；
- 执行时用**命令本身**命名当前会话（`ctx.sessionTitle.rename`）。

对标 Claude Code 的 `!<command>`，但会显式把结果交给模型并要求回复。插件是**纯插件**：不 patch dsh、不写 `app.asar`。

## 2. 快速命令

```bash
npm run check    # node --check index.js && node --check client.js
npm test         # node --test "tests/**/*.test.mjs"
npm run verify   # check + test（提交前必须通过）

# 本地链接安装（开发迭代，改动经重载立即生效）
plugin_manager action=install_bundle target=/Users/lzx/Documents/GitHub/dsh-shell-cmd

# 推送仓库 + 从 GitHub 仓库重装到当前 profile（发布/换机复用）
scripts/publish-install.sh            # 默认 commit + push + 安装 + 校验
scripts/publish-install.sh --dry-run  # 只打印计划
```

环境事实（dsh 注入，终端里不一定有）：

- `DSH_PROFILE`：当前 profile 名（如 `desktop`）；脚本缺失时默认 `desktop`。
- `DSH_PROFILE_DIR`：profile 目录（如 `~/.dsh/profiles/desktop`）。
- `DSH_HOME`：`~/.dsh`。

## 3. 文件职责

| 路径 | 作用 |
| --- | --- |
| `index.js` | **Host 半端**：`/cmd` 命令注册、shell 执行、正文组装、`agent.followup()`、会话标题同步 |
| `client.js` | **Client 半端**：`window.__ModuleLoader__` 懒工厂；终端卡片 + 输入框「终端命令模式」提示条 |
| `cordis.patch.yml` | bundle patch：插入一行 Host 插件（`include:shell-cmd`） |
| `package.json` | bundle 声明（`dsh.bundle.patch`）、`dsh.client` 声明、`exports`/`files` |
| `locale/{en,zh}.json` | 插件管理页的 `meta.title` / `meta.description` |
| `icon.svg` | 插件图标（原创，≤256 KiB） |
| `tests/command.test.mjs` | Host 半端单测（伪 ctx/agent/shell，不 spawn、不联网） |
| `scripts/publish-install.sh` | 推送 + 仓库安装 + 校验脚本 |
| `README.md` | 面向用户的功能/安装/边界说明 |

## 4. 数据流与关键契约

```
用户输入 /cmd <cmd>
  → [Host] commands 服务 → handler
      0. ctx.sessionTitle.rename(session, 命令)        // 可选服务
      1. ctx.workingDirectory.ensure(agent)            // cwd
      2. ctx.shell.resolve → execute → result()        // 前台等待、超时、取消
      3. agent.followup(UserMessage{source:{kind:'shell-command'}})  // 模型据此回复
  → [会话日志] session/title + command/run + command/done（log-only，不进模型历史）
  → [Client] conversation.chat.commandview(key=cmd) 读取 CommandNode → 终端卡片
```

必须遵守：

1. **Host 导出形态**：只有具名导出 `{ name, inject, apply }`，不能有 `export default`（否则 Loader 把默认导出当插件本体，`inject` 丢失）。`apply` 的返回值只能是 effect（清理函数/iterator 等），不能返回普通对象。
2. **不静态 import 任何 `@deepseek-ai/*` 核心包**。链接安装（工作区）与仓库安装（profile 内无该包依赖）都解析不到 dsh 安装内的包。需要 `UserMessage` 时就地构造与 `createUserMessage()` 等价的结构：
   ```js
   { id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'shell-command', command } }
   ```
   需要 schemastery 的能力一律不要引入；可调值用常量 + `apply(ctx, config)` 防御式读取。
3. **模型输入只走 `agent.followup()`**。命令结果本身（`CommandResult.text`）是 UI/log-only 文本，不能另写 session 事件、不能 patch `system-prompt`/`agent/request`。
4. **`CommandNode` 结构**（Client 侧消费）：
   ```js
   { kind:'command', seq, time, commandId, name:'cmd'|null, args:string|null,
     outcome:null | { kind:'success'|'error', text?, sourceEventSeq? } }
   ```
   卡片只依赖这些字段；`args` 是命令原文（可能带前导空白，需 `trim`）。
5. **外观只走主题令牌** `--dsw-alias-*`（`bg-*`、`border-*`、`label-*`、`state-*`、`brand-primary`）。禁止字面颜色（图标/插画除外）；明暗主题必须自动跟随。
6. **可见文案走 Client locale**：`ctx.locale.register(NS, { en, zh })` + `ctx.locale.bind(NS)`，`NS = 'dsh-shell-cmd'`。组件内必须有英文兜底，`t` 抛错不能让整张卡片崩溃。
7. **Client 半端形态**：`window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... return { inject, apply } } })`；只能 `require('react')`，无 JSX（`React.createElement`）；样式用 `<style data-plugin-css>` 注入，并在 `ctx.effect` 的清理函数里移除；所有注册（样式、locale、slot）都放 `ctx.effect` / `ctx.slots.inject`，卸载时自动撤销。
8. **会话标题**：`ctx.sessionTitle.rename()` 以 `source:'user'` **固定**标题，之后自动标题不再覆盖。按 `session/title` 事件 seq 记录「本插件写过的那一次」：
   - 无标题 / 自动标题 → 写入命令；
   - 本插件写过 → 更新为最新命令；
   - 人工改过（`source.kind==='user'` 且 seq 不匹配）→ **不要覆盖**。
   没有 `sessionTitle` 服务时静默跳过；`nameSession:false` 可关闭。
9. **shell 沙箱策略必须显式传**，不能靠“不传 `sandboxPolicy`”来表示不沙箱：`@deepseek-ai/dsh-bash-sandbox` 的 `resolve()` 会把缺省值补成**部署默认策略**（`ctx.sandboxPolicy.resolve()`，不带 session），于是命令会跑在部署默认的 workspace root / 模式下（典型症状：`/cmd git pull` 报 `.git/FETCH_HEAD: Operation not permitted`）。
   - 默认（人类命令）→ 显式 `{ mode: 'danger-full-access', workspaceRoot, sessionId }`，见 `resolveShellSandboxPolicy()`；
   - `useSessionPolicy: true` → 用 `ctx.sandboxPolicy.resolve({ session })`，与模型 bash 工具同边界；
   - 环境变量由 `dsh-bash-local` 决定：`bash -c` + 进程 env + `NO_COLOR/TERM=dumb/PAGER=cat/GIT_PAGER=cat` 覆盖，不加载用户 shell rc。改这一块前先读该包。

## 5. 修改指南

- 加/改 Host 行为 → `index.js`；纯文本组装放进现有 `compose*` 函数，保持可单测。
- 卡片外观/交互 → `client.js` 的 `ShellCommandCard`；新文案同时加到 `en`/`zh` 两张字典和 `locale/*.json`（插件展示元数据）。
- 命令名、描述、输入提示 → `apply()` 里的 `ctx.commands.register`；改了命令名必须同步改 Client 的 `commandview` key（当前 `cmd`）。
- 输出上限/超时 → `DEFAULT_*`/`STDOUT_MAX_BYTES`；改动后同步 README 的表格。
- **不要**把 `/cmd` 改成模型可调用的工具（`ctx.tools.register`）：它是人类动作，默认不套沙箱（见第 4 节第 9 条）。
- 新增文件后**必须同步 `package.json` 的 `files`**：仓库安装（tarball/git）按 `files` 打包，漏写会导致安装后运行时缺文件，且本地链接安装不会暴露这个问题。

## 6. 测试与验证

- 提交前：`npm run check && npm test`（当前 68 例全绿）。
- Host 新逻辑必须补 `tests/command.test.mjs` 用例，使用伪 `ctx`/`agent`/`shell`，不得 spawn 真进程或联网。
- 本地链接安装后重载 Host：`plugin_manager action=set_plugin target=include:shell-cmd enabled=false` → `true`（或重启 DSH）。**改 `client.js` 需要刷新页面**（没有 `pnpm run dev:web` 时不做 HMR 热替换），不要承诺自动更新。
- 验证已注册：`cordis_inspect_query` Client `Slots.listSubTree` root=`conversation.chat.commandview` 应出现 occupant `key=cmd, active=true`。
- 无浏览器控制时，视觉只能人工确认：如实报告“插槽已注册、视觉未验证”，不要用 mock 页面/截图工具伪造验证。
- 禁止用 `plugin_manager` 以外的方式手改 profile 的 `package.json` / `cordis.patch.yml`；`scripts/publish-install.sh` 走官方 CLI `dsh plugin --profile <name> add <spec>`，由它回写 bundle 列表。

## 7. 发布 / 从仓库重装

`scripts/publish-install.sh` 做四件事：

1. 脏工作区 → `git add -A && git commit`（`bash scripts/publish-install.sh --no-commit` 可跳过，但要求工作区干净）；
2. `git push -u origin HEAD`（`--no-push` 跳过）；
3. 用当前 commit 的 GitHub tarball（默认）或 git spec 安装到 profile：
   `dsh plugin --profile "$DSH_PROFILE" add "https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>"`；
   CLI 会跑 pnpm 并把声明了 `dsh.bundle` 的包自动加入 `dsh.profile.bundles`；
4. 校验 profile 的依赖 spec、bundle 列表与已安装版本，打印重载提示。

注意：

- 仓库必须是**公开**的（默认走匿名 tarball）；私有仓库用 `--spec "github:<owner>/<repo>#<sha>"` 或带凭据的 URL。
- 安装由 `dsh plugin` 调用 pnpm 完成。脚本优先用 `DSH_PNPM`，其次 macOS Desktop 内置 runtime pnpm（与 profile 管理器同版本，避免重解析整个 lockfile），最后回退 PATH 上的 pnpm。
- git 传输被网络策略挡住时（例如受限沙箱）tarball 通道可能仍可用（`codeload.github.com` 与 `api.github.com` 走 HTTPS）。
- 受限网络下 `pnpm add` 会去重新解析 profile 里**与本插件无关**的 GitHub 依赖（例如 `dsh-to-figma` 的 release tarball），可能卡住/失败；这不是脚本或插件的问题。换正常网络执行，或先 `--dry-run` 检查。
- 安装后 Host 模块需要重载才生效（插件页拨动开关或重启 DSH）；Client 改动另需刷新页面。
- 本地链接安装（`plugin_manager install_bundle` 指向工作区）只用于开发迭代；发布/换机用脚本。两者二选一，脚本会把 `link:` 改成 tarball/git spec。
- 发布后如果希望恢复“改代码立即生效”的开发体验，重新做一次本地链接安装即可。

## 8. 排错

| 现象 | 排查 |
| --- | --- |
| `/cmd` 不在命令菜单 | `plugin_manager list_plugins` 看 `include:shell-cmd` 是否 `active`；`Config.listConfigs name=dsh-shell-cmd` |
| 卡片不出现、显示通用命令行 | `Slots.listSubTree root=conversation.chat.commandview` 是否有 `key=cmd`；页面是否刷新过 |
| 卡片空白/崩溃 | 浏览器控制台 `slot entry crashed in 'conversation.chat.commandview'`；检查 `props.node` 防御与 locale 兜底 |
| 会话名不变 | 该会话是否被人工改过名（尊重用户）；`sessionTitle` 服务是否存在；`nameSession` 配置 |
| `/cmd` 报 `Operation not permitted` / `cannot open .git/FETCH_HEAD` | 沙箱策略被部署默认值接管：确认 `shell.resolve` 请求里带 `mode: 'danger-full-access'`（`resolveShellSandboxPolicy`）；见第 4 节第 9 条 |
| 环境变量与终端不一致 | 已知设计：`bash -c` + DSH 进程 env，不加载 shell rc；用 `zsh -lc '…'` / 显式 `source` 兜底 |
| 安装后缺文件 | `package.json` 的 `files` 是否覆盖新增文件；仓库安装按 `files` 打包 |
| 插件行 active 但命令报错 | Host 侧 `apply` 抛错会被回滚；看 `.plugin-manager/logs` 或重载后的 fiber 状态 |

## 9. 提交约定

- 用 Conventional Commits 前缀（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`），中文描述可读即可。
- 一次提交聚焦一件事；`npm run verify` 通过后再提交。
- 运行时代码（`index.js`/`client.js`/`locale`/`icon`/patch）与文档/测试可以分开提交，但**不要提交未通过 verify 的版本**。
