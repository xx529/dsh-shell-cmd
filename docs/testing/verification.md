# 交互终端三修复 · 独立验收 checklist 与验证方案

- 文档：`docs/testing/verification.md`
- 作者：tester（独立验收角色；只写 `docs/testing/**` 与 `tests/regression/**`，不改产品代码与既有测试）
- 创建：2026-10-28（task-4 准备阶段）
- 状态：**checklist 已定稿，执行记录待 task-5 填写**
- 验收对象：`dsh-shell-cmd` 仓库（dsh 插件），三处修复 ①相对 `/api` 传输 ②`/cmd` 居中模态 ③关闭后不再自动重开
- 实现归属：frontend（task-2：`client.js` / `package.json` / `README.md`）、backend（task-3：`index.js` / `terminal.js` / 既有测试）

---

## 1. 验收范围与不变量

### 1.1 三处用户可见问题与根因

| 编号 | 现象 | 根因（已由诊断确认） | 期望修复 |
| --- | --- | --- | --- |
| Bug-1 | 裸 `/cmd` 打开交互终端报 `Failed to fetch` | `client.js` 用 `__DSH_TRANSPORT__.streamBaseUrl` 拼绝对地址；桌面页面 origin 是 `dsh-app://app`，绝对地址跨源 | 改为页面相对地址 `api/cmd-terminal/rpc`，不再做绝对化 |
| Bug-2 | `/cmd` 体验与 `/context` 不一致（无居中模态/无遮罩模糊） | 面板挂在 `conversation.input.dock`；打开由轮询/claim 副作用触发 | 用 `commandUi.decorate` 的 bare 调用 action 打开；面板迁到 `conversation.input.overlay` 并渲染居中模态 |
| Bug-3 | 弹出后关不掉（Esc 后立即重开） | claim 阶段自动 `setTerminalOpen(true)`，且 Esc 后草稿仍残留 `/cmd` 触发立刻重开 | 删除 claim 自动打开逻辑；Esc 关闭时清空残留 `/cmd` 草稿 |

### 1.2 必须保持的产品不变量（回归底线）

1. **只有 `finish`（Ctrl+Enter）才 `agent.followup()`**；`close`（Esc）只 abort 运行中命令并删状态，**绝不**把终端内容发给模型。
2. `command/run` / `command/done` 是 log-only，不进模型历史。
3. `/cmd <命令>` 仍由 Host 执行并 `followup`，会话标题规则、沙箱策略（`danger-full-access`）不变。
4. 终端卡片（`conversation.chat.commandview`，key=`cmd`）保持现状；带 `OPEN_MARKER` 的空参数结果不渲染卡片。
5. 外观只走 `--dsw-alias-*` 主题令牌，明暗主题自动跟随，禁止字面颜色（`var()` 的 fallback 参数除外）。
6. 仓库安装按 `package.json.files` 打包，新增/保留文件不能漏声明。
7. Host 导出形态只有具名导出 `{ name, inject, apply }`，`apply` 只返回 effect。
8. 不静态 import `@deepseek-ai/*` 核心包（client 侧只 `require('react')`）。

---

## 2. 环境事实与验证通道限制（必须先读）

本机可用于验收的通道只有三类：

| 通道 | 可用性 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 静态核查（`git diff` / 源码阅读 / grep） | ✅ 可用 | 代码契约、端点、槽位名、样式声明、逻辑分支存在性 | 运行期真实行为、渲染效果 |
| 命令与单测（`npm run check` / `npm test` / `npm run verify`） | ✅ 可用 | Host 逻辑正确性、语法、既有回归 | 浏览器内行为（client.js 无运行时单测） |
| Host 侧 inspect / plugin manager | ✅ 可用（安装后） | 插件 active、Slot occupant 已注册、Config 可读 | 元素真的渲染、视觉正确、点击真的生效 |
| 浏览器/页面控制 | ❌ **不可用** | — | 视觉、交互、真实点击 |

**浏览器控制不可用的具体事实（必须如实写入报告）：**

- Electron 桌面端未暴露 CDP/远程调试端口（已知监听端口不含调试端口）；
- GUI 需要认证 token/cookie，本机无受支持的注入通道；
- 没有可用的 headless 浏览器 harness 驱动真实 dsh 页面。

因此：

- 本验收**不会产出截图、不会声称“已点测”**。
- 所有视觉/交互项一律标记为 **`未验证（无浏览器控制通道）`**，附人工复验步骤（第 7 节）。
- 运行时 inspect 结果只作为“**注册事实**”证据，不能外推为“视觉已确认”。

---

## 3. 判定口径

### 3.1 严重度定义

| 级别 | 含义 | 对裁定的影响 |
| --- | --- | --- |
| CRITICAL | 三个 bug 中任一未被修复，或破坏 1.2 的核心不变量（如 close 触发 followup） | 直接 FAIL |
| HIGH | 主路径契约缺失/错误（端点、槽位、action、Esc 清草稿、Host 生命周期），会导致用户可见故障 | 直接 FAIL |
| MEDIUM | 体验/健壮性/样式细节偏差，不阻断主流程 | 记录，不单独导致 FAIL |
| LOW | 文档、命名、注释、次要一致性 | 记录 |

### 3.2 二值裁定规则

- **PASS**：无 CRITICAL、无 HIGH 未通过项；所有能执行的检查均有证据；未覆盖项已显式列出且不掩盖风险。
- **FAIL**：任一 CRITICAL 或 HIGH 项判定失败/无法取证。
- MEDIUM/LOW 项失败不改变裁定，但必须写入“残留问题”。
- 无法验证项不得算作通过，只能算“未覆盖”；若未覆盖项本身承载 CRITICAL 契约（如“相对端点是否真的可达”），裁定需在报告中标注 **PASS（有限）** 并写明边界，由 Lead 决定是否接受。

### 3.3 证据标准（每条检查必须可复核）

- 静态：`file:line` + 关键代码片段（引用最终 diff 后的文件内容，而不是旧版本）。
- 命令：完整命令 + 退出码 + 关键输出（用例数/失败数）。
- 运行时：工具名 + 入参 + **原始返回摘录**（不得改写）。
- 人工：必须写“未验证”与复验步骤，禁止编造结果。

---

## 4. Checklist（分组）

> 结果列在 task-4 阶段统一为 `待执行`；task-5 执行时逐项填 `PASS` / `FAIL` / `未验证` / `不适用`，并在第 9 节附证据。
> 检查项编号在 task-5 的执行记录中保持不变，便于交叉引用。

### 4.1 A 组 · Client 静态/契约层（`client.js`、`package.json`、`README.md`）

| ID | 检查项 | PASS 判定口径 | 证据 | 严重度 | 结果 |
| --- | --- | --- | --- | --- | --- |
| A1 | RPC 端点必须是页面相对地址 | 存在字面量 `'api/cmd-terminal/rpc'` 并被直接用于 `fetch(...)`；不存在用 `__DSH_TRANSPORT__` / `streamBaseUrl` / `document.baseURI` / `new URL(..., base)` 对终端请求做绝对化的路径；不存在 `terminalEndpoint()` 这类返回绝对 URL 的包装 | grep + `client.js:line` 片段 | CRITICAL | 待执行 |
| A2 | 面板注册到 overlay 槽 | `ctx.slots.inject('conversation.input.overlay', ...)`（或等价注册）存在；注册项 `id: 'shell-cmd-terminal'`；通过 `inject` 回传 `sessionId`；终端面板由该槽渲染 | `client.js:line` | HIGH | 待执行 |
| A3 | `commandUi.decorate` action 打开终端 | 存在 `ctx.inject(['commandUi'], ...)` 且调用 `commandUi.decorate({ name:'cmd', available, ui:{ kind:'action', run } })`；`run(session)` 用 `session.sessionId` 调 `setTerminalOpen(..., true)`；注册放在 `ctx.effect` 内可清理；`package.json.dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-commands` 且保留原有两项 | `client.js:line` + `package.json:line` | CRITICAL | 待执行 |
| A4 | 已删除 claim 阶段自动打开 | 不存在“`claimName === 'cmd' && draft.trim() === '/cmd'` → `setTerminalOpen(..., true)`”或任何等价的 claim 驱动打开逻辑；claim 仅允许用于轮询频率等无副作用用途（如保留，必须说明） | grep `claim` + `client.js:line` | CRITICAL | 待执行 |
| A5 | Esc 关闭并清理残留草稿 | 面板打开期间在 `document` 上注册 capture 阶段 `keydown`；`Esc` 且 `event.isComposing` 为假时 `preventDefault()`+`stopPropagation()`；关闭序列包含：best-effort RPC `close`（失败忽略）→ `setTerminalOpen(false)` → 若 composer 草稿 `trim()` 等于 `/cmd` 则 `inputActions.setDraft('')`；面板输入框自身 Esc 也走同一关闭函数 | `client.js:line` | HIGH | 待执行 |
| A6a | 模态遮罩结构 | 打开时渲染 `position:fixed; inset:0; z-index:200` 的遮罩层，内部 `display:flex` 居中卡片；点击遮罩关闭，卡片内 `stopPropagation` | `client.js:line`（样式对象/注入 CSS） | HIGH | 待执行 |
| A6b | 背景模糊与主题令牌 | 遮罩含 `backdrop-filter:blur(3px)` 且带 `-webkit-` 前缀；背景用 `var(--dsw-alias-bg-mask-1, ...)`；卡片背景/边框/圆角/阴影走 `--dsw-alias-*` 或 `--dsw-shadow-*`；卡片宽 `min(860px,100%)`、最大高 `min(82vh,720px)` | `client.js:line` | MEDIUM | 待执行 |
| A6c | 无字面颜色 | 新增样式中不存在裸颜色（`#rgb`/`rgb()`/`hsl()`/命名色）被直接使用；`rgba(...)` 只允许作为 `var()` 的 fallback 第二参数 | grep + `client.js:line` | MEDIUM | 待执行 |
| A7 | 传输健壮性 | `fetch` 请求带 `method:'POST'`、`credentials:'same-origin'`、`cache:'no-store'`、`headers:{'content-type':'application/json'}`、`body:JSON.stringify({method, params:{sessionId,...}})`、`signal:AbortSignal.timeout(15000)`；响应非 JSON 或 `ok!==true` 抛可读错误；`error.code` 映射本地化文案（至少 `session-not-found`）；模态内展示错误且提供重试按钮 | `client.js:line` | HIGH | 待执行 |
| A8 | 交互细节保持 | 命令执行中输入行 `readOnly`（不是 `disabled`）；打开/执行结束把焦点还给输入行；有 loading/error 态；`finish` 成功后关闭面板（`setTerminalOpen(false)`） | `client.js:line` | MEDIUM | 待执行 |
| A9 | 兜底路径收敛 | 保留 `commandview` 看到 `OPEN_MARKER` 且新鲜的打开路径（按 `commandId`/`seq` 去重）；`status` 轮询兜底只在面板关闭时运行；不存在 `input.dock` 上的终端面板残留注册 | `client.js:line` | MEDIUM | 待执行 |
| A10 | 版本与打包声明 | `package.json.version` 为 `0.3.12`；`dsh.client.inject` 新增项正确；`files` 仍覆盖 `terminal.js` 等运行文件，无新增未声明文件 | `package.json:line` | MEDIUM | 待执行 |
| A11 | README 同步 | 交互终端章节改为“`/context` 式模态、背景模糊、Esc 关闭并清空、相对 `/api` 传输、`commandUi` 装饰触发”；排错表中与本次相关的行已更新；未改无关章节 | `README.md:line` | LOW | 待执行 |
| A12 | Client 半端形态未被破坏 | 仍是 `window.__ModuleLoader__.load({ id:'<包名>', factory(require){...} })`；只 `require('react')`；无 JSX；样式 `<style data-plugin-css>` 并在 effect 清理；只具名导出 `{ inject, apply }` | `client.js:line` | HIGH | 待执行 |

### 4.2 B 组 · Host 静态/契约层（`terminal.js`、`index.js`）

| ID | 检查项 | PASS 判定口径 | 证据 | 严重度 | 结果 |
| --- | --- | --- | --- | --- | --- |
| B1 | `status` 是只读 peek | `registry.status(sessionId)` 不 `delete pendingOpens`；返回 `{ pendingOpen, open }`；重复调用结果不衰减 | `terminal.js:line` | HIGH | 待执行 |
| B2 | `open` 消费 pendingOpen 且幂等 | `open(sessionId)` 删除该会话 pendingOpen；同会话重复 `open` 不重复建 state、不抛错 | `terminal.js:line` | HIGH | 待执行 |
| B3 | `close` 清理 | `close(sessionId)` 同时清 `pendingOpens` 与 state，并 abort 运行中 controller；无 state 时返回 `false` 不抛错 | `terminal.js:line` | HIGH | 待执行 |
| B4 | finish/close 语义不变量 | `finish` 是唯一 `agent.followup` 调用点；`close` 不触碰 `followup`；`finish` 成功删 state；`busy`/`empty` 错误码语义不变 | `terminal.js:line` + 测试 | CRITICAL | 待执行 |
| B5 | 路由收敛到 `connection.fetch` | `index.js` 只保留 `connection.fetch.register({path:'/api/cmd-terminal/rpc', methods:['POST'], requestBody:'buffered', fetch})`；不再注册 `webServer` 根路径 `/cmd-terminal/rpc`；不再使用 `createTerminalRpcHandler` / `TERMINAL_ROUTE`（或对应 import 已清理）；伪 ctx 无 `webServer` 时 `apply` 仍成功并注册 `/api` 路由 | `index.js:line` + 回归测试 | HIGH | 待执行 |
| B6 | 可用性判定收敛 | `isTerminalModeAvailable(ctx)` 只要求 `agents` + `connection.fetch.register`，不再要求 `webServer`；`apply` 的 `isTerminalReady` 与之一致 | `index.js:line` | MEDIUM | 待执行 |
| B7 | fetch route 信封与状态码 | 成功 `200` 且 `{ok:true, value}`；失败 `{ok:false, error:{code, message, details:{}}}`；未知 method → `400`；缺 sessionId → `400`；`session-not-found` → `404`；`busy`/`empty` → `409`；响应带 `cache-control:no-store` | `terminal.js:line` + 回归测试 | MEDIUM | 待执行 |
| B8 | 裸 `/cmd` 打开信号仍存在 | 裸 `/cmd` 且终端就绪时返回 `OPEN_MARKER` 并 `requestOpen(sessionId)`；不可用时返回 `USAGE` 错误 | `index.js:line` + 测试 | MEDIUM | 待执行 |

### 4.3 C 组 · 单测/命令层

| ID | 检查项 | PASS 判定口径 | 证据 | 严重度 | 结果 |
| --- | --- | --- | --- | --- | --- |
| C1 | 语法检查 | `npm run check` 退出码 `0` | 命令 + 退出码 | HIGH | 待执行 |
| C2 | 既有测试 | `npm test` 退出码 `0`，记录用例总数/通过数/失败数 | 命令 + 退出码 + 摘要 | HIGH | 待执行 |
| C3 | 提交门禁 | `npm run verify` 退出码 `0` | 命令 + 退出码 | HIGH | 待执行 |
| C4 | backend 改动有测试覆盖 | 既有测试（或 backend 新增用例）覆盖：status 不消费、open 消费、close 清理、重复 open 幂等、`/api` route 成功/错误、`apply` 无 `webServer` | 用例名清单 + 位置 | MEDIUM | 待执行 |
| C5 | tester 独立回归测试 | 新增 `tests/regression/shell-cmd.test.mjs`，`node:test` 实现，**不 spawn 真进程、不联网**；覆盖第 5 节 R 系列用例；运行退出码 `0`；未修改既有测试文件与产品代码 | 文件 + 运行记录 | HIGH | 待执行 |

### 4.4 D 组 · 安装后运行时注册核查（Lead 通知安装后执行）

| ID | 检查项 | PASS 判定口径 | 证据 | 严重度 | 结果 |
| --- | --- | --- | --- | --- | --- |
| D1 | 插件已启用 | `plugin_manager action=list_plugins` 中 `include:shell-cmd` 状态为 `active`（记录 version/spec） | 原始返回摘录 | HIGH | 待执行 |
| D2 | overlay 槽已注册 | `cordis_inspect_query` client `Slots.listSubTree` root=`conversation.input.overlay` 的 occupants 中出现 `id=shell-cmd-terminal`（`key`/`id` 字段按真实返回记录） | 原始返回摘录 | HIGH | 待执行 |
| D3 | 提示条仍在 dock | 同一方法 root=`conversation.composer.dock` 中仍存在 `shell-cmd-hint` occupant | 原始返回摘录 | MEDIUM | 待执行 |
| D4 | Host Config 可读 | `cordis_inspect_query` host `Config.listConfigs` name=`dsh-shell-cmd` 返回该 entry/配置 schema，无报错 | 原始返回摘录 | MEDIUM | 待执行 |
| D5 | 命令已注册（可选补证） | Host 侧可见 `/cmd` 命令（若 inspect 无法列出命令，则引用 D4/D1 并在报告注明“命令注册由单测覆盖”） | 原始返回摘录 | LOW | 待执行 |

> 注意：D2/D3 只能证明“注册存在”，**不能证明**模态真的渲染、遮罩真的模糊、Esc 真的可关。后者只能人工（E 组）。

### 4.5 E 组 · 视觉/交互（本机不可验证，全部 `未验证`）

| ID | 人工检查项 | 期望结果 | 严重度 | 结果 |
| --- | --- | --- | --- | --- |
| E1 | 桌面客户端刷新页面后输入裸 `/cmd` 并回车 | 不出现 `Failed to fetch`；不提交消息；输入框 `/cmd` 被消费清空 | CRITICAL | 未验证 |
| E2 | 模态外观 | 出现居中卡片；全屏遮罩；背景轻微模糊（blur 3px 观感）；与 `/context` 模态观感一致 | HIGH | 未验证 |
| E3 | 执行命令 | 模态内输入 `echo hi` 回车 → 输出 `hi`，cwd 正确，滚动区自动滚底 | HIGH | 未验证 |
| E4 | Esc 关闭 | 模态消失；输入框内**不残留** `/cmd`；不会立即重开 | CRITICAL | 未验证 |
| E5 | 再次打开 | 再次输入 `/cmd` 回车能正常打开；不会被上一次关闭影响 | HIGH | 未验证 |
| E6 | 点遮罩关闭 | 点击遮罩空白处关闭；点卡片内部不关闭 | MEDIUM | 未验证 |
| E7 | Ctrl+Enter 发送 | 终端内容作为消息发给模型，面板关闭，对话出现模型回复；不产生莫名卡片 | HIGH | 未验证 |
| E8 | `/cmd <命令>` 不受影响 | 仍由 Host 执行并 followup，终端卡片正常渲染 | HIGH | 未验证 |
| E9 | 明暗主题 | 切换明/暗主题，遮罩与卡片颜色跟随，无字面颜色违和 | MEDIUM | 未验证 |
| E10 | 错误态 | 会话未就绪/终端不可用时有可读错误文案 + 重试按钮，不白屏/不崩溃 | MEDIUM | 未验证 |
| E11 | 焦点/键盘 | 打开后焦点在终端输入行；执行中 `readOnly` 且不丢焦点；执行完焦点回来 | MEDIUM | 未验证 |
| E12 | 控制台无异常 | 无 `slot entry crashed`、无 unhandled rejection | MEDIUM | 未验证 |

### 4.6 F 组 · 负向/边界场景

| ID | 场景 | 期望 | 验证手段 | 严重度 | 结果 |
| --- | --- | --- | --- | --- | --- |
| F1 | 终端不可用（无 connection.fetch/agents）时裸 `/cmd` | 返回 `USAGE` 错误文本，不打开面板 | 单测（既有或回归） | MEDIUM | 待执行 |
| F2 | 会话未找到（`session-not-found`） | `/api` route 返回 404 + 错误信封；client 展示本地化文案 + 重试 | 回归测试 + 静态（E10 人工补视觉） | HIGH | 待执行 |
| F3 | 命令运行中重复 `send` | `409 busy`；不并发执行 | 回归测试 | MEDIUM | 待执行 |
| F4 | 未执行任何命令就 `finish` | `409 empty`；不 followup | 回归测试 | HIGH | 待执行 |
| F5 | Esc（close）绝不 followup | 伪 agent 的 `followup` 调用次数为 0；state 被删除 | 回归测试 | CRITICAL | 待执行 |
| F6 | 关闭运行中命令 | `close` abort controller；后续 result 处理不抛未捕获异常 | 回归测试（伪 runShell） | MEDIUM | 待执行 |
| F7 | 历史回放/重复渲染 | 旧 `OPEN_MARKER` 不触发打开（新鲜度判断）；pendingOpen 只被消费一次；`status` 重复轮询不丢请求 | 静态 + 回归测试 | HIGH | 待执行 |
| F8 | 空/坏请求体 | 非 JSON、空 body、缺 method → `400`；超大 body → 若 route 用 `request.json()` 则记录实际行为（不限流属已知边界） | 回归测试 | LOW | 待执行 |

---

## 5. tester 独立回归测试设计（`tests/regression/shell-cmd.test.mjs`）

> 只新增文件，不改 `tests/terminal.test.mjs` / `tests/command.test.mjs`。`node:test` + `node:assert/strict`。
> **不 spawn 真进程、不联网**：所有 Host 依赖用伪 `ctx`/`agent`/`shell`/`runShell`；`fetch` route 用 WHATWG `Request`/`Response` 直接调用，不发真实网络请求。
> **静态源码断言（R11–R16）在注释中明确写“源码锁定（regression lock），不是行为验证”。**

### 5.1 Host 注册表（`createTerminalRegistry`）

| ID | 用例 | 构造 | 断言 |
| --- | --- | --- | --- |
| R1 | status 是 peek，不消费 pendingOpen | 伪 `ctx`（`get('agents')` 返回含该 session 的 agent map，`workingDirectory.ensure` 返回 `/tmp`）；`requestOpen(sid)` 后连续两次 `status(sid)` | 两次均 `pendingOpen===true`；`open===false`（未 open 过） |
| R2 | open 消费 pendingOpen | 同上，`requestOpen` → `await open(sid)` → `status(sid)` | open 返回快照（含 `lines`/`cwd`）；随后 `pendingOpen===false`、`open===true` |
| R3 | 重复 open 幂等 | `await open(sid)` 两次 | 不抛错；两次都返回快照；`has(sid)===true`；期间 `ensure` 只被调用一次（用计数断言） |
| R4 | close 清理 | open 后 `close(sid)` | 返回 `true`；`has(sid)===false`；随后 `status(sid)` 的 `pendingOpen===false`、`open===false` |
| R5 | close 幂等/无状态 | 未 open 时 `close(sid)` | 返回 `false`，不抛错 |
| R6 | close 清掉未消费的 pendingOpen | `requestOpen(sid)` → `close(sid)` → `status(sid)` | `pendingOpen===false` |
| R7 | close 不 followup | 伪 agent 的 `followup` 计数；`open` 后 `close` | `followup` 调用 0 次；`has===false` |
| R8 | finish 才 followup，成功后删状态 | open → `send('echo hi')`（伪 runShell 返回输出）→ `finish` | `followup` 恰好 1 次；参数含 `echo hi` 与 cwd；`has(sid)===false` |
| R9 | finish 在 busy 时拒绝 | 伪 runShell 挂起（不 resolve）→ 不 await 的 `send` 后立即 `finish` | `rejects` 且 `error.code==='busy'`；`followup` 0 次 |
| R10 | finish 在无命令时拒绝 | open 后直接 `finish` | `rejects` 且 `error.code==='empty'`；`followup` 0 次 |

> 说明：R8–R10 属“不变量防回归”，即使 backend 未改这些行为也必须保持；如伪 ctx 构造与现有测试重复，仍保留独立副本以证明“tester 独立验证”。

### 5.2 `/api` fetch route（`createTerminalFetchRoute`）

| ID | 用例 | 构造 | 断言 |
| --- | --- | --- | --- |
| R11 | 成功信封 | 伪 registry（`open` 返回 `{lines:[],cwd:'/tmp'}`）+ `new Request('http://x/api/cmd-terminal/rpc', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({method:'open',params:{sessionId:'s1'}})})` | `status===200`；`{ok:true, value:{...}}`；`cache-control:no-store` |
| R12 | 缺 method → 400 | body `{}` | `status===400`；`{ok:false, error:{code:'bad-request', details:{}}}` |
| R13 | 缺 sessionId → 400 | body `{method:'open', params:{}}` | `status===400`；`code==='bad-request'` |
| R14 | 未知 method → 400 | body `{method:'nope', params:{sessionId:'s1'}}` | `status===400`；`code==='bad-request'`；message 含 `unknown method` |
| R15 | session-not-found → 404 | 伪 registry `open` 抛 `code='session-not-found'` | `status===404`；`ok===false`；`code==='session-not-found'` |
| R16 | busy → 409 | 伪 registry `finish` 抛 `code='busy'` | `status===409`；`code==='busy'` |
| R17 | 非 JSON body 不崩溃 | body `'not-json'` | 返回 400（`bad-request`），不抛出未捕获异常 |
| R18 | 成功响应 200 时 `STATUS_BY_CODE` 不被误用 | 伪 registry 返回 `{ok:true}` | `status===200` |

> 若 `createTerminalFetchRoute` 在最终实现中签名/行为变化（例如要求第二个参数），以最终 diff 为准调整构造，但断言语义保持不变。

### 5.3 `index.js` apply 与可用性（伪 ctx）

| ID | 用例 | 构造 | 断言 |
| --- | --- | --- | --- |
| R19 | apply 不依赖 webServer | 伪 ctx：`effect` 收集清理函数；`inject(['connection'], fn)` 用 child（`get('connection')` 返回带 `fetch.register` 的 service，`effect` 收集）；`commands.register` 捕获；**故意不提供 `webServer`**（或提供 `webServer.register` 直接抛错以证明未被触碰） | `apply` 不抛错；`fetch.register` 被调用 1 次，参数 `path==='/api/cmd-terminal/rpc'`、`methods` 含 `POST`、`requestBody==='buffered'`、`fetch` 为函数；`webServer.register` 未被调用 |
| R20 | isTerminalModeAvailable 收敛 | 仅 `agents` + `connection.fetch.register` 的 ctx → true；去掉 connection → false；去掉 agents → false；只提供 `webServer`（无 connection）→ false | 三/四组断言 |
| R21 | 裸 `/cmd` 仍返回 OPEN_MARKER 并 requestOpen | 伪 ctx + terminal registry stub + 伪 agent（`session.id='s1'`），`executeShellCommand(ctx,{agent,rawInput:'',signal:...})` | 返回 `{kind:'success', text: OPEN_MARKER}`；`requestOpen` 被调用 `'s1'` |
| R22 | 终端不可用时裸 `/cmd` 返回 USAGE | `isTerminalReady:()=>false` | 返回 `{kind:'error', text: USAGE}`；不调用 `requestOpen` |
| R23 | `apply` 注册 `/cmd` 命令且 handler 存在 | 伪 ctx（同 R19） | `commands.register` 参数 `name==='cmd'`；`handler` 为函数；描述/input 未被破坏 |

### 5.4 client.js 源码锁定（静态断言，非行为验证）

> 用 `fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8')` 读取源码文本。
> **每一条断言前注释：`// 源码锁定：防止回归到已知 bug 的实现，不构成运行时行为验证。`**

| ID | 断言 | 目的 |
| --- | --- | --- |
| R24 | 含 `'api/cmd-terminal/rpc'`，且不含 `__DSH_TRANSPORT__`、`streamBaseUrl`、`document.baseURI` 用于 RPC 的绝对化 | 锁定 Bug-1 修复 |
| R25 | 含 `conversation.input.overlay` 与 `shell-cmd-terminal` | 锁定槽位迁移 |
| R26 | 含 `commandUi` 与 `decorate`；含 `kind: 'action'`（或等价对象字面量） | 锁定 Bug-2 主路径 |
| R27 | 不含 `claimName === 'cmd' && draft.trim() === '/cmd'` 形式的自动打开（用正则匹配 `claim` 与 `setTerminalOpen` 同行/邻近的模式，若确需精确匹配，断言 `claimName` 附近没有 `setTerminalOpen`） | 锁定 Bug-3 根因移除 |
| R28 | Esc 关闭路径包含 `setDraft`；包含 `isComposing`；包含 capture 阶段 `keydown` | 锁定 Esc 清草稿 |
| R29 | 含 `backdrop-filter`（或 `backdropFilter`）、`z-index:200`（样式字符串/对象）、`--dsw-alias-bg-mask-1` | 锁定遮罩 |
| R30 | `package.json` 中 `version==='0.3.12'` 且 `dsh.client.inject` 含 `@deepseek-ai/dsh-client-ui-commands` | 锁定客户端依赖声明 |

> 静态断言的局限必须写进执行记录：**源码存在某字符串 ≠ 运行时行为正确**；行为侧只能依赖 Host 单测 + 人工 E 组。

### 5.5 运行方式

```bash
node --test tests/regression/shell-cmd.test.mjs
npm run verify   # 应把新文件一并纳入 "tests/**/*.test.mjs"
```

约束：新测试不得修改既有文件、不得依赖 profile 安装状态、不得读取 `~/.dsh`、不得发起真实 HTTP。

---

## 6. 执行步骤（task-5 按序执行）

1. `git status` / `git diff` / `git log` 记录最终实现 commit 或工作区 diff（若未提交，记录 `git diff` 全文路径与 `git diff --stat`）。
2. 逐项静态核查 A/B 组，填表并记录 `file:line` 证据。
3. 编写 `tests/regression/shell-cmd.test.mjs`（第 5 节 R1–R30），运行并记录结果。
4. 运行 `npm run check`、`npm test`、`npm run verify`，记录命令与退出码。
5. Lead 通知安装完成后：执行 D1–D5，记录原始返回。
6. 视觉/交互 E 组：全部标 `未验证（无浏览器控制通道）`，保留人工步骤。
7. F 组负向场景按第 4.6 节执行（单测/静态），能验证的填结果，不能验证的标“未覆盖”。
8. 更新本文档第 8/9 节（执行记录 + 裁定），`send_message` 给 lead。

---

## 7. 人工复验步骤（交给用户/Lead 在真实桌面客户端执行）

> 前提：安装/重载 Host（插件开关拨动或重启 DSH），并**刷新页面**（client.js 改动无 HMR）。
> 记录方式：每步截图 + 浏览器/Electron DevTools Console 无红色报错。

1. **准备**：打开桌面客户端，新建会话（确保没有历史 `/cmd` 卡片干扰）。
2. **打开（Bug-2/1）**：输入框输入 `/cmd`（不要跟参数）→ 按 Enter。
   - 期望：输入框 `/cmd` 被消费清空；不提交模型消息；出现居中模态，背景轻微模糊；无 `Failed to fetch`。
3. **执行**：模态输入行输入 `echo hi` → Enter。
   - 期望：显示 `$ echo hi` 与 `hi`；焦点仍在输入行。
4. **关闭（Bug-3）**：按 Esc。
   - 期望：模态立即消失；输入框为空（不残留 `/cmd`）；等待 ≥3 秒不自动重开。
5. **二次打开（Bug-3）**：再次输入 `/cmd` → Enter。
   - 期望：模态正常打开；Esc 仍能关闭且不重开。
6. **遮罩点击**：打开模态后点击卡片外的遮罩区域 → 期望关闭；点卡片内部不关闭。
7. **Ctrl+Enter 发送**：打开模态，执行 `pwd`，按 Ctrl+Enter。
   - 期望：面板关闭；对话中出现用户消息（含 cwd 与 transcript）；模型回复；**不**出现无意义终端卡片。
8. **Cmd 带参数回归**：输入 `/cmd echo ok` → Enter。
   - 期望：Host 执行并 followup；终端卡片正常渲染；会话标题规则符合既有行为。
9. **错误态**：在会话未就绪/终端不可用时（如新建会话立刻打开、或断开 Host）触发 `/cmd`。
   - 期望：模态内显示可读错误与“重试”按钮，不白屏。
10. **主题**：切换明/暗主题，观察遮罩与卡片颜色是否跟随。
11. **控制台**：全程 DevTools Console 无 `slot entry crashed`、无 unhandled rejection。
12. **Web 端（可选）**：若使用 `dsh web` 页面，重复 2–5，确认相对地址在 Web origin 下同样可用（桌面 `dsh-app://app` 与 Web `http://127.0.0.1:<port>` 两条路径都要覆盖）。

---

## 8. 已知风险、未覆盖项与依赖

| 项 | 说明 | 影响 |
| --- | --- | --- |
| 视觉/交互未验证 | 无浏览器/页面控制通道；E 组全部只能人工 | 不能自证“模态真的居中/模糊/可 Esc 关闭”；裁定需标注有限 |
| 桌面壳转发未自证 | `dsh-app://app/api/...` 经 Electron `forwardWebRequest` 注入 cookie 的行为无法在本机自动化（无 CDP/无 token 注入） | Bug-1 的“真实跨源修复”只有静态+问卷式人工证据 |
| Client 无运行时单测 | 仓库无 jsdom/React 测试设施；新增测试只做源码锁定 | 行为验证依赖人工 E 组 |
| 依赖 dsh 内部 API 契约 | `commandUi.decorate` 入参形状、`conversation.input.overlay` 的 inject/props、`inputActions.setDraft` 由宿主版本提供；只能通过安装后 Slots inspect + 人工验证 | 宿主版本变化可能破坏契约 |
| 轮询/去重逻辑 | `OPEN_MARKER` 新鲜度、`status` 轮询节奏、去重 key 只在源码层核查，未做时间序列测试 | 边界时序问题可能漏检 |
| 桌面与 Web 双 origin | 两条 origin 路径只有人工可覆盖 | 可能一端通过另一端失败 |
| `npm test` 范围 | 只覆盖 Host（`index.js`/`terminal.js`）；既有无 client 测试 | client 侧回归只能靠源码锁定 + 人工 |
| 环境依赖 | 运行时核查需 Lead 完成安装并重载；未安装时 D 组标“未执行”，不能算通过 | 裁定完整性 |

---

## 9. 执行记录（task-5 填写）

> 本节在实现完成、tester 收到 Lead 通知后填写。所有“结果”必须与第 4 节 checklist ID 一一对应。
> **禁止填写未实际执行的命令或未实际看到的返回。**

### 9.1 基线信息

| 字段 | 值 |
| --- | --- |
| 验收时间 | （待填） |
| 仓库 HEAD | （待填） |
| 工作区是否干净 / diff 范围 | （待填） |
| 实现 commit（若有） | （待填） |
| Node 版本 | （待填） |
| 安装状态（Lead 通知） | （待填） |

### 9.2 静态核查结果（A/B 组）

（待填：逐项结果 + `file:line` 证据片段）

### 9.3 命令与单测记录（C 组）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run check` | （待填） | （待填） |
| `npm test` | （待填） | （待填：pass/fail 数） |
| `npm run verify` | （待填） | （待填） |
| `node --test tests/regression/shell-cmd.test.mjs` | （待填） | （待填） |

### 9.4 新增回归测试结果（C5）

（待填：R1–R30 通过情况；被调整的构造与原因）

### 9.5 运行时注册核查（D 组，原始返回摘录）

（待填：D1–D5 工具名、入参、返回原文）

### 9.6 视觉/交互（E 组）

（待填：全部 `未验证（无浏览器控制通道）`；列出 E1–E12 与人工复验步骤引用）

### 9.7 负向场景（F 组）

（待填）

### 9.8 最终裁定

| 字段 | 值 |
| --- | --- |
| 裁定 | （待填 PASS / FAIL） |
| CRITICAL 失败项 | （待填） |
| HIGH 失败项 | （待填） |
| MEDIUM/LOW 残留 | （待填） |
| 未覆盖项 | （待填） |
| 人工待验项 | （待填） |
| 证据文件 | `docs/testing/verification.md` + `tests/regression/shell-cmd.test.mjs` |
