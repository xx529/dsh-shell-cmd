# 交互终端三修复 · 独立验收 checklist 与验证方案

- 文档：`docs/testing/verification.md`
- 作者：tester（独立验收角色；只写 `docs/testing/**` 与 `tests/regression/**`，不改产品代码与既有测试）
- 创建：2026-10-28（task-4 准备阶段）
- 状态：**checklist 已定稿；0.3.12 三修复验收 PASS（第 9 节）；0.3.13 追加验收「发送后保留命令行卡片」PASS（第 10 节，含 10.7 GitHub 重装后运行时核查；视觉/交互仍待人工）**
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
- 无法验证项不得算作通过，只能算“未覆盖”；若未覆盖项本身承载 CRITICAL 契约（如“相对端点是否真的可达”），裁定需在报告中标注 **PASS** 并显式列出未覆盖项/边界（可写作“PASS（含未覆盖项）”或“PASS（有限）”），由 Lead 决定是否接受。

### 3.3 证据标准（每条检查必须可复核）

- 静态：`file:line` + 关键代码片段（引用最终 diff 后的文件内容，而不是旧版本）。
- 命令：完整命令 + 退出码 + 关键输出（用例数/失败数）。
- 运行时：工具名 + 入参 + **原始返回摘录**（不得改写）。
- 人工：必须写“未验证”与复验步骤，禁止编造结果。

---

## 4. Checklist（分组）

> 结果列在 task-4 阶段统一为 `待执行`；task-5 执行时逐项填 `PASS` / `FAIL` / `未验证` / `不适用`，并在第 9 节附证据。**本次（2026-10-28）逐项判定与证据见第 9 节：A/B 组静态 → 9.2，C 组命令/用例 → 9.3/9.4，D 组运行时 → 9.5，E 组视觉 → 9.6，F 组负向 → 9.7，最终裁定 → 9.8。**
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

## 9. 执行记录（task-5）

> 执行时间：2026-10-28 09:52 ~ 10:05（Asia/Shanghai）。所有“结果”均来自本次实际执行的命令/工具返回，未执行或未看到的项如实标注。
> 说明：安装由 Lead 执行；tester 在委托沙箱内对 `plugin_manager` 的调用被权限拒绝（见 9.5），已用 profile 文件做独立旁证，并列出无法自证的项。

### 9.1 基线信息

| 字段 | 值 |
| --- | --- |
| 仓库 HEAD | `303f699aaceb83c9b867918d12e417171dc2f69b`（`fix: 裸 /cmd 改为 /context 式模态，修复 Failed to fetch 与无法关闭`） |
| 验收开始时工作区 | clean（`git status --short` 为空） |
| 被验实现范围 | 相对 HEAD 的上一提交 `cae1d9a`，diff 覆盖 `client.js`/`index.js`/`terminal.js`/`package.json`/`README.md`/`AGENTS.md`/既有测试 |
| 验收期间 tester 产生的变更 | 仅新增 `tests/regression/shell-cmd.test.mjs`、修改本文件（`docs/testing/verification.md` 第 9 节）；**未修改任何产品代码或既有测试** |
| Node / npm | `v22.22.2` / `10.9.7` |
| 安装状态 | Lead 通知：`plugin_manager install_bundle target=/Users/lzx/Documents/GitHub/dsh-shell-cmd` → `dsh-shell-cmd 0.3.12 <- ../../../Documents/GitHub/dsh-shell-cmd`，enabled/applied，profile 依赖切为 link |
| 独立安装旁证（tester 只读核对） | `~/.dsh/profiles/desktop/package.json:20` → `"dsh-shell-cmd": "link:/Users/lzx/Documents/GitHub/dsh-shell-cmd"`；bundles 列表含 `dsh-shell-cmd`；`~/.dsh/profiles/desktop/node_modules/dsh-shell-cmd -> ../../../../Documents/GitHub/dsh-shell-cmd`；被 link 的包 `package.json` version=`0.3.12` |
| 浏览器控制通道 | 不可用（无 CDP / 无 token 注入 / 无 headless 页面 harness） |

### 9.2 静态核查结果（A/B 组）

> 证据行号均按 HEAD `303f699` 的最终文件内容核对。判定以“修复契约 + 不变量”为准。

#### A 组 · Client（`client.js` / `package.json` / `README.md`）

| ID | 结果 | 证据（file:line + 关键片段） |
| --- | --- | --- |
| A1 | **PASS** | `client.js:653` `const TERMINAL_RPC = 'api/cmd-terminal/rpc'`；`client.js:756` `response = await fetch(TERMINAL_RPC, {`；可执行代码中无 `streamBaseUrl` / `__DSH_TRANSPORT__` / `document.baseURI` / `new URL(`（`streamBaseUrl` 仅出现在 `client.js:648` 的说明性块注释中）；`function terminalEndpoint` 已不存在。R24 源码锁定通过 |
| A2 | **PASS** | `client.js:1199` `ctx.slots.inject('conversation.input.overlay', ...)`；`client.js:1202-1205` `{ name:'conversation.input.overlay', id:'shell-cmd-terminal', order:20, inject:(sessionId)=>({sessionId}) }`；模态 JSX `client.js:1114-1135`（`dsc-term-backdrop`/`dsc-term-card`/`role=dialog`/`aria-modal`） |
| A3 | **PASS** | `client.js:1179` `ctx.inject(['commandUi'], (scope) => {`；`client.js:1182-1192` `scope.commandUi.decorate({ name:'cmd', available:()=>true, ui:{ kind:'action', run:(session)=>{...setTerminalOpen(id,true)} } })`；注册包在 `scope.effect(...)` 中（`:1180-1181`）；`package.json:43-45` 三个 inject 包齐全，含 `@deepseek-ai/dsh-client-ui-commands` |
| A4 | **PASS** | 可执行代码中不存在“claim 命中 cmd 即 `setTerminalOpen`”的行：`claimName` 仅用于 `ShellCmdHint`（`client.js:615-629`），与终端开关无交集；R27 源码锁定通过 |
| A5 | **PASS** | 关闭函数 `client.js:1054-1074`：best-effort `terminalRpc(sessionId,'close').catch(()=>{})`（`:1060`）→ `setTerminalOpen(sessionId,false)`（`:1061`）→ 当 `draftRef.current.trim() !== '/cmd'` 直接返回，否则 `inputActions.setDraft('')`（`:1065-1069`）；Esc 捕获监听 `client.js:1076-1085`（`keydown` capture=true、`event.isComposing===true` 忽略、`preventDefault+stopPropagation`）；终端输入框 Esc 走 `onClose()`（`:941-945`）；另有 80ms 幂等去重（`:1045`、`:1057-1058`） |
| A6a | **PASS** | `client.js:250-262` `.dsc-term-backdrop { position:fixed; inset:0; z-index:200; display:flex; align-items:center; justify-content:center; padding:24px }`；遮罩点击关闭 `client.js:1118-1122`（`event.target === event.currentTarget`），卡片内 `stopPropagation`（`:1130`） |
| A6b | **PASS** | `client.js:259-261` `background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45)); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);`；卡片 `client.js:263-274`（`width:min(860px,100%)`、`max-height:min(82vh,720px)`、`var(--dsw-alias-bg-layer-1)`、`var(--dsw-alias-border-l2)`、`border-radius:12px`、`var(--dsw-shadow-lv3,...)`） |
| A6c | **PASS** | 新增样式仅用 `--dsw-alias-*` / `--dsw-shadow-*`；唯一字面色值 `#0006` 是 `var(--dsw-shadow-lv3, ...)` 的 fallback（`client.js:273`），`rgba(0,0,0,0.45)` 是 `var(--dsw-alias-bg-mask-1, ...)` 的 fallback（`:259`） |
| A7 | **PASS（含 1 处有意偏离）** | `client.js:750-753` 超时计算、`:756-767` fetch 选项（`method:'POST'`、`credentials:'same-origin'`、`cache:'no-store'`、`content-type: application/json`、`body: JSON.stringify(payload)`、`AbortSignal.timeout(...)`）；错误映射 `client.js:721-744` + 文案表 `:59-71`(en)/`:102-114`(zh)；错误 + 重试按钮 `client.js:984-991`。**偏离**：轻量 RPC 15s（`:656`），`send` 单独放宽到 130s（`:662`、`:882`）以覆盖 Host 120s 命令超时；与 task-2 文字“15s”不同，但理由已写在代码注释/README，判定为合理偏离、非缺陷 |
| A8 | **PASS** | `client.js:1002-1003` 输入行 `readOnly: busy \|\| sent`（不是 disabled）；焦点回给输入行 `client.js:869-871`；loading/error 态 `client.js:977-992`；`finish` 成功后 `setSent(true)` + `onClose()`（`:906-911`） |
| A9 | **PASS** | 兜底 marker 打开 `client.js:455-477`（`isTerminalResult` 判空 args + OPEN_MARKER + 15s 新鲜度 + `openedTerminalMarkers` 按 `commandId:seq` 去重、上限 64）；轮询仅在 `!open` 时运行 `client.js:1087-1110`；可执行代码无 `name:'conversation.input.dock'` 注册（R25 锁定） |
| A10 | **PASS** | `package.json:3` version `0.3.12`；`:43-45` inject；`files` 含 `client.js`/`terminal.js`/`index.js` 等（`:20-30`），无新增未声明运行文件 |
| A11 | **PASS** | `README.md:73-160` 交互终端章节已改为模态/打开方式/外观/关闭方式/传输；`README.md:286-287` 数据流与装饰说明；`README.md:330-333` 排错行（Failed to fetch / 面板不打开 / 会话未就绪） |
| A12 | **PASS（源码锁定）** | `client.js:21` `window.__ModuleLoader__.load({`；`client.js:1212` `return { inject: ['slots', 'locale'], apply }`；仅 `require('react')`；无 JSX（全部 `h(...)`）；样式经 `insertStyle`/effect 清理。**注意**：这是静态形态检查，未做运行时加载验证（见 9.5 client inspector 超时） |

#### B 组 · Host（`terminal.js` / `index.js`）

| ID | 结果 | 证据（file:line + 关键片段） |
| --- | --- | --- |
| B1 | **PASS** | `terminal.js:230-231` `status(sessionId) { return { pendingOpen: pendingOpens.has(sessionId), open: states.has(sessionId) } }`——无 `delete`；行为验证 R1 通过 |
| B2 | **PASS** | `terminal.js:245-248` `open` 先 `pendingOpens.delete(sessionId)` 再 `ensureState`；R2/R3 通过（open 消费、重复 open `ensure` 仅 1 次） |
| B3 | **PASS** | `terminal.js:351-358` `close` 清 `pendingOpens`、abort `state.controller`、删 state；无 state 返回 false；R4/R5/R6 通过 |
| B4 | **PASS** | `finish` 唯一 followup：`terminal.js:334` 标题同步、`:343` `agent.followup(...)`、`:346` `states.delete(sessionId)`；`close` 分支无 followup（`:351-358`）；R7（close 不 followup）/R8（finish 才 followup 且删状态）/R9（busy）/R10（empty）全部通过 |
| B5 | **PASS** | `index.js:463-490` 只保留 `ctx.inject(['connection'], ...)` 内 `createTerminalFetchRoute` + `fetch.register({ path: TERMINAL_FETCH_PATH, methods:['POST'], requestBody:'buffered', fetch })`；可执行代码无 `webServer`、无 `createTerminalRpcHandler`、无 `TERMINAL_ROUTE`（R33 锁定）；import 已收敛为 `OPEN_MARKER, TERMINAL_FETCH_PATH, createTerminalRegistry, createTerminalFetchRoute`（`index.js:22-28`）；R19 用“webServer 一碰就炸”的伪 ctx 验证 apply 不触碰它 |
| B6 | **PASS** | `index.js:335-345` `isTerminalModeAvailable` 只读 `agents` + `connection.fetch.register`；R20 四组断言通过；既有测试 `tests/command.test.mjs:561` 亦覆盖 |
| B7 | **PASS** | `terminal.js:384-389` `STATUS_BY_CODE`（bad-request 400 / session-not-found 404 / busy,empty 409）；`:438-448` `jsonResponse`（超 256KiB 降级 500）；`:459-473` route 分派；R11–R18 通过（200/400/404/409/坏 JSON） |
| B8 | **PASS** | `index.js:390-405` 裸 `/cmd`：`isTerminalReady` → 不可用返回 `USAGE`、可用时 `requestOpen(...)` 并返回 `OPEN_MARKER`；R21/R22/R23 通过 |

### 9.3 命令与单测记录（C 组）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `npm run check` | `0` | `node --check` 三文件通过（无输出） |
| `npm test` | `0` | `# tests 115` / `# suites 18` / `# pass 115` / `# fail 0`（新增回归测试前） |
| `node --test tests/regression/shell-cmd.test.mjs` | `0` | `# tests 35` / `# pass 35` / `# fail 0`（R1–R35） |
| `npm test`（加入回归测试后） | `0` | `# tests 150` / `# suites 25` / `# pass 150` / `# fail 0` |
| `npm run verify` | `0` | `# tests 150` / `# suites 25` / `# pass 150` / `# fail 0` |

### 9.4 新增独立回归测试（C5）

文件：`tests/regression/shell-cmd.test.mjs`（`node:test`，不 spawn 真进程、不联网；所有 Host 依赖为伪 ctx / 伪 registry / WHATWG `Request`/`Response`）。

| 覆盖域 | 用例 | 结果 |
| --- | --- | --- |
| registry 生命周期 | R1 status peek 不消费 / R2 open 消费 / R3 重复 open 幂等（ensure 仅 1 次）/ R4 close 清状态 / R5 无状态 close 幂等 / R6 close 清 pendingOpen / R7 close 不 followup | 全 PASS |
| finish 语义 | R8 finish 才 followup（含 cwd/命令文本）且删状态 / R9 busy 拒绝 / R10 empty 拒绝 | 全 PASS |
| 运行中边界 | R34 close abort 运行中 signal / R35 重复 send busy 且不并发 | 全 PASS |
| /api route | R11 成功 200 + no-store / R12 缺 method 400 / R13 缺 sessionId 400 / R14 未知 method 400 / R15 session-not-found 404 / R16 busy+empty 409 / R17 非 JSON 400 / R18 成功不被错误映射 | 全 PASS |
| index.js apply | R19 只注册 connection.fetch 的 `/api` 路由、webServer 陷阱未被触碰 / R20 isTerminalModeAvailable 四组 / R21 裸 /cmd 返回 OPEN_MARKER + requestOpen / R22 不可用返回 USAGE / R23 apply handler 无 connection 时走 USAGE | 全 PASS |
| 源码锁定（**非行为验证**） | R24 相对端点且无绝对化 / R25 overlay 注册 + hint 保留 + 无 input.dock / R26 commandUi.decorate action / R27 无 claim 自动打开 / R28 Esc capture + setDraft / R29 遮罩 fixed/inset/z200/blur/令牌 / R30 same-origin/no-store/timeout/错误映射/retry/readOnly / R31 package.json 0.3.12 + commandUi 依赖 / R32 terminal.js 无旧 handler / R33 index.js 无 webServer | 全 PASS |

过程说明：首次运行有 2 例失败（R19/R23），原因是 tester 测试夹具的伪 `ctx.effect` 没有模拟 dsh “回调立即执行”的语义，导致 route 注册未发生；**只修改了测试文件**（让 `effect` 立即执行回调并保存 disposer），与产品代码无关；修正后全绿。

局限（必须在裁定中体现）：R24–R33 是“源码锁定”，只证明源码中存在/不存在某实现，**不是运行时行为验证**；client 端真实渲染/点击/网络行为无法在本机自动化。

### 9.5 安装后运行时注册核查（D 组，原始返回摘录）

> tester 在委托沙箱内无法调用 `plugin_manager`（权限被拒）、client inspector 也超时；因此 D1–D3 由 **Lead 代跑**并回传原文，tester 只做转录与交叉核对（不伪造成 tester 自己执行）。D2/D3 的页面已被 client HMR 热替换为 0.3.12 新 bundle。

| ID | 结果 | 工具/入参 | 原始返回 / 说明 |
| --- | --- | --- | --- |
| D1 | **PASS（Lead 代跑）** | `plugin_manager action=list_plugins`（offset=200 页，节选该行） | 原文：`{"entryId":"include:shell-cmd","moduleName":"dsh-shell-cmd","enabled":true,"fiberPhase":"active","patchId":"shell-cmd"}`。安装事实：profile `package.json:20` 为 `"dsh-shell-cmd": "link:/Users/lzx/Documents/GitHub/dsh-shell-cmd"`，`node_modules/dsh-shell-cmd` 为工作区符号链接，安装输出 `+ dsh-shell-cmd 0.3.12 <- ../../../Documents/GitHub/dsh-shell-cmd`，enabled/applied。**fiber 判据以 `fiberPhase:"active"` 为准，不用 Config.status。** |
| D2 | **PASS（Lead 代跑）** | `cordis_inspect_query` client `Slots.listSubTree` `{"root":"conversation.input.overlay"}` | `available=true`；`selected.occupants` 含原文 `{"registrant":"Gb","id":"shell-cmd-terminal","order":20,"priority":0,"active":true}`；同槽其他 occupant：`slash-menu(0)`、`command-popup(1)`、`feedback-dialog(2)`、`context-modal(10, dsh-context)`、`popout-window-draft(100)`；`standardProps` 列表含 `useInput` / `inputActions` / `sessionId`（证实组件能拿到三者）。 |
| D3 | **PASS（Lead 代跑）** | 同上 root=`conversation.composer.dock`；root=`conversation.chat.commandview` | composer.dock：`available=true`，occupant 原文 `{"registrant":"Gb","id":"shell-cmd-hint","order":20,"priority":0,"active":true}`；chat.commandview：occupant 原文 `{"registrant":"Gb","key":"cmd","priority":0,"active":true}`。 |
| D4 | **PASS（tester 实跑）** | `cordis_inspect_query` host `Config.listConfigs` `{"name":"dsh-shell-cmd"}` | 返回：`{"entries":[{"id":"include:shell-cmd","patchId":"shell-cmd","name":"dsh-shell-cmd","status":"absent"}],"total":1,"nextOffset":null}`。按 scout 提醒：`status:"absent"` 表示本插件没有 Config schema，**不能据此判断 active/fiber 状态**；fiber 判据用 D1 的 `fiberPhase:"active"`。 |
| D5 | **PASS（间接）** | — | 命令注册由 `tests/command.test.mjs:1145/1168/1212/1266` 与回归 R19/R23 覆盖；运行时工具未单独列出 `/cmd` 命令（低风险，记录为未单独取证）。 |

**运行时注册核查结论：PASS。** 依据：
1. Host fiber `enabled:true` + `fiberPhase:"active"`；
2. 三个 client 槽 occupant 均 `active:true`，且新 overlay 槽出现 `id=shell-cmd-terminal`——旧版（0.3.11）终端注册在 `conversation.input.dock`，新槽位注册成功说明页面已加载 0.3.12 新 client bundle；
3. `standardProps` 含 `useInput`/`inputActions`/`sessionId`，与 A2/A5 代码假设一致（Esc 清草稿所需的 `inputActions.setDraft` 有来源）。

补充旁证（保留）：client 侧 `ctx.inject([...])` 是 dsh 客户端插件既有用法（`~/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js` 内 `e.inject([`configForms`], ...)`，同时其返回的静态 `inject` 只有 `['slots','locale']`），与本插件写法一致。

### 9.6 视觉/交互（E 组）

**全部为“未验证（无浏览器控制通道）”。**

原因（如实）：本机无可用页面控制通道——Electron 桌面端未暴露 CDP/远程调试端口；GUI 需要认证 token/cookie 且无受支持的注入方式。client inspector 后来恢复可用（D2/D3 已由 Lead 实跑，证明槽位注册 active），但 **inspect 只能证明“注册存在”，不能证明真实渲染、样式、点击或网络响应**。因此：

- 不产出截图，不声称做过点击走查；
- E1–E12（模态出现/Failed to fetch 消失/背景模糊/执行 echo hi/Esc 关闭且草稿无 /cmd/二次打开/点遮罩关闭/Ctrl+Enter 发送且无卡片/`/cmd <cmd>` 回归/明暗主题/错误态/焦点/控制台）全部 `未验证`；
- 人工复验步骤见第 7 节（刷新页面 → 新会话 `/cmd` Enter → 模态 → `echo hi` → Esc → 输入框无 `/cmd` → 再次打开 → 点遮罩 → Ctrl+Enter → `/cmd echo ok` → 主题/错误态/控制台）。

### 9.7 负向场景（F 组）

| ID | 结果 | 证据 |
| --- | --- | --- |
| F1 | **PASS**（Host 逻辑） | R22/R23：不可用 → `USAGE`，不 requestOpen、不注册路由 |
| F2 | **PASS（Host 契约）/ 视觉未验证** | R15：`session-not-found` → 404 + 错误信封；client 本地化文案 `client.js:70`(en)/`:108`(zh) + 重试 `client.js:985-992`（静态锁定 R30）；模态内实际展示未验证 |
| F3 | **PASS** | R9/R16/R35：busy → 409 / 拒绝并发 |
| F4 | **PASS** | R10：empty → 拒绝且 followup=0；R16 empty→409 |
| F5 | **PASS** | R7（close 不 followup）+ R8（仅 finish followup） |
| F6 | **PASS** | R34：close 时运行中 signal 已 abort，且不产生未捕获异常 |
| F7 | **PASS（Host 行为 + client 源码锁定）** | R1/R2（status 可重复 peek、open 只消费一次）+ 源码锁定 R24–R33（`openedTerminalMarkers` 去重、15s 新鲜度）；真实时序/回放场景未验证 |
| F8 | **PASS（route 层）** | R17：非 JSON body → 400 不崩溃；超大 body 行为依赖 `request.json()` 实现，本次未单独构造（记录为“未覆盖的低风险项”） |

### 9.8 最终裁定

| 字段 | 值 |
| --- | --- |
| **裁定** | **PASS** —— 静态契约、Host 单测（150/150）、独立回归（35/35）、安装后运行时注册（Host fiber active + 3 个 client 槽 occupant active）均通过；未发现 CRITICAL/HIGH 失败项。视觉/交互与页面 Network 实际响应仍为人工待验（见下） |
| CRITICAL 失败项 | 无 |
| HIGH 失败项 | 无 |
| 运行时注册核查 | **PASS**：D1 `fiberPhase:"active"`；D2 overlay occupant `id=shell-cmd-terminal, active:true`（证明新 client bundle）；D3 composer.dock `shell-cmd-hint`、chat.commandview `key=cmd` 均 active；D4 Config entry 可读（status=absent 仅表示无 schema） |
| 未覆盖 / 未验证项（不作为失败证据，也不作为通过证据） | ① E1–E12 视觉与交互（无浏览器控制通道）——含模态居中/背景模糊真实渲染、Esc 后输入框无 `/cmd`、点遮罩、Ctrl+Enter 发送后无卡片、明暗主题、焦点、控制台无异常；② 页面 Network 中 `api/cmd-terminal/rpc` 实际 200 JSON（传输契约已由静态锁定 + 相对端点 + 同源配置 + D2 新 bundle 佐证，但没有实际抓包）；③ 真实桌面 `dsh-app://app` 下 forward+cookie 的实际成功（同上）；④ D5 运行时命令列表未单独取证 |
| MEDIUM/LOW 残留 | ① A7：`send` 超时 130s 与 task 描述字面 15s 不同（有合理理由，已文档化）；② F8 超大 body 未单独测试（route 层非 JSON/缺字段已测）；③ `close` 的 80ms 幂等去重依赖时间窗口（符合预期）；④ AGENTS.md 同步变更不在本验收范围 |
| 人工待验项 | 第 7 节 E1–E12 全部；重点：刷新页面后（1）新会话 `/cmd` + Enter → 居中模态 + 背景模糊、无 `Failed to fetch`；（2）执行 `echo hi` 有输出；（3）Esc 关闭后输入框无 `/cmd` 且 3 秒内不重开；（4）再次 `/cmd` 能打开；（5）`/cmd echo ok` 仍走 Host 且卡片正常；（6）Ctrl+Enter 发送后无残留卡片——**注：0.3.13 起改为「应出现一条终端卡片」，见第 10 节；该项旧期望已作废** |
| 证据文件 | `docs/testing/verification.md`（本文件）+ `tests/regression/shell-cmd.test.mjs` |

**裁定解释（二值口径）**：按第 3.2 节，“任一 CRITICAL/HIGH 失败即 FAIL”。本次所有可执行检查（静态契约、Host 单测、独立回归、安装后注册）均 PASS，没有失败项；剩余未覆盖项集中在**本机无法自动化的浏览器视觉/交互与真实网络抓包**，已如实标注并给出人工复验步骤。因此裁定 **PASS（含未覆盖项）**：代码与可观测注册层面可签收；用户可见行为的最终确认请按第 7 节人工执行，若人工复验发现异常，应回到 FAIL。

---

## 10. 追加验收：交互终端 Ctrl+Enter 后保留命令行卡片（task-8 / 0.3.13，2026-10-28）

> 本章节验收购自 task-7（backend2）的增量：交互终端 `finish()` 追加 log-only 的 `command/run` + `command/done`，使对话里保留一条终端卡片。
> 本章节**更新** §9.6/E7 与 §9.8 人工待验项（6）的旧期望：Ctrl+Enter 发送后现在**应当**出现一条卡片；Esc/close 仍**不应**出现卡片。
> 验收范围仍为 tester 写作用域：`tests/regression/**`、`docs/testing/**`；未修改产品代码/既有测试。

### 10.1 改动范围与契约（最终 diff 核对）

| 文件 | 变更 | 证据（当前工作区） |
| --- | --- | --- |
| `terminal.js` | 新增 `appendCommandLifecycle(agent, type, data)`：只调 `agent.session.append(type,data)`，无 `session`/无 `append`/抛错都返回 `false`（best-effort） | `terminal.js:151-176`（函数体 `:167`） |
| `terminal.js` | `finish()`：`syncSessionTitle` 后生成 `commandId = 'cmd-terminal-' + crypto.randomUUID()`，先追加 `command/run`（`{commandId,name:'cmd',args:firstCommand,source:{kind:'user'}}`），再 `agent.followup(...)`，成功后追加 `command/done`（`{commandId,kind:'success',text:transcript.text}`） | `terminal.js:368-403`（run `:369`；followup `:384`；done-success `:399`） |
| `terminal.js` | `followup` 抛错：仅当 `recorded`（run 已落日志）时补 `command/done {kind:'error', text}`，错误原样再抛；`run` 追加失败则不补 `done` | `terminal.js:385-397`（error done `:389`） |
| `terminal.js` | `finish` 成功后仍 `state.sent=true` + 删除 Host 会话状态（原语义不变） | `terminal.js:405-407` |
| `terminal.js` | `close()` 分支零改动、零 append（Esc/点遮罩绝不产生卡片） | `close` 函数（与 §9.2 B3 相同），R41/R44 锁定 |
| `package.json` | `version` 0.3.12 → **0.3.13** | `package.json:3` |
| `README.md` / `AGENTS.md` | 文档同步「Ctrl+Enter 后对话保留终端卡片」「Esc 不产生卡片」「log-only、不进模型上下文」 | `README.md` 交互终端章节/快捷键表/终端内行为；`AGENTS.md` 第 4 节第 10 条 |
| `tests/terminal.test.mjs` | backend2 新增 8 例（见 10.3） | `tests/terminal.test.mjs:498-636` |
| `tests/regression/shell-cmd.test.mjs` | tester 新增 R36–R44（9 例）+ 夹具支持 `session.append` 记录/失败注入；R31 标题/断言版本同步 0.3.13 | `tests/regression/shell-cmd.test.mjs:381-541` |

**契约要点（逐项核对结论）**：

| # | 契约 | 结论 | 证据 |
| --- | --- | --- | --- |
| C1 | 顺序必须是 `command/run → followup → command/done` | **PASS** | R36 `calls.order === ['append:run','followup','append:done']`；`terminal.js:369/384/399` |
| C2 | run/done 必须共用同一 `commandId` | **PASS** | 同一局部变量 `commandId`（`:368`），R36/R40 断言相同 |
| C3 | `run.data = {commandId,name:'cmd',args:<第一条命令>,source:{kind:'user'}}` | **PASS** | R36 逐字段断言；source 便于其它插件识别为用户动作 |
| C4 | `done.data.text` = 已 clip 的 transcript（不是 modelText/说明头） | **PASS** | R36 断言 `'$ echo one\nhi\n$ echo two\nhi'`；R44 锁定 `text: transcript.text`；R37 断言模型文本里没有 commandId/事件名 |
| C5 | `run` 追加失败不阻断 followup，且不补孤立 done | **PASS** | R38：append 仅 `['command/run']`、followup=1、finish 成功、状态删除 |
| C6 | `done` 追加失败不影响 finish | **PASS** | R39：append 尝试 run+done、followup=1、finish 成功 |
| C7 | `followup` 抛错补 `kind:'error'` 的 done，错误原样抛出，状态保留 | **PASS** | R40：done.kind='error'、同 commandId、rejects `/followup failed/`、`has('s1')===true` |
| C8 | `close`（Esc/点遮罩）绝不追加、不 followup | **PASS** | R41：`append=[]`、followup=0、order=[]；R44 静态锁定 close 块无 `append` |
| C9 | 第二次 `finish` 不重复追加 | **PASS** | R42：第二次 reject `code='empty'`，append 数不变、followup 仍 1 |
| C10 | 无 `session.append` 时 finish 仍成功 | **PASS** | R43：append=[]、followup=1、finish 成功 |
| C11 | 模型输入语义不变（仍只走 followup；header+cwd+transcript；source kind `shell-command`） | **PASS** | R37；既有 `tests/command.test.mjs`/`tests/terminal.test.mjs` 全绿 |
| C12 | 生命周期事件 log-only、不进模型上下文 | **PASS（契约层）** | 事件只经 `session.append`；模型输入仅 `agent.followup`；dsh 侧 `command/run`/`command/done` 是已知 log-only 事件（见 10.2） |

### 10.2 对 dsh 宿主契约的独立核对（不止看本仓库测试）

为确认“Host 追加事件后，Client 零改动就能出卡片”，tester 从本机 `app.asar` 独立提取了 dsh 内部实现并核对（只读，未改 dsh）：

- 提取方式：解析 asar 头部 JSON 后按偏移读取 `@deepseek-ai/dsh-commands/lib/index.js` 与 `@deepseek-ai/dsh-client-ui-chat/lib/client.js`（asar 路径 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`）。
- `dsh-commands` 的 `execute()`：`command/run` 追加 `{commandId,name,args?,source:{kind:'user'}}`；`command/done` 追加 `{commandId,kind,text?,sourceEventSeq?}`；`appendLifecycle(session,type,data)` 直接 `session.append.bind(session)(type,data)`（**同步**，失败以 throw 暴露），`settleThrown` 对 `command/done` 错误做 contained（只 warn）。→ 与本插件的事件形状/同步 append/best-effort 语义一致。
- `dsh-client-ui-chat` 的 `commandDefinition.match`：`command/run` → `{id:String(data.commandId), role:'start'}`；`command/done` → `{id:String(data.commandId), role:'update'}`；`commandFromRun` 生成 `{kind:'command',seq,time,commandId,name:data.name,args:data.args ?? null,outcome:null}`；`commandFromDone` 填 `outcome:{kind,text?}`；`CommandNodeView` 把节点渲染到 **`conversation.chat.commandview`，entryKey = `command.name ?? ''`**。
- 结论：本插件以 `name:'cmd'` + 同一 `commandId` 追加 run/done 后，Chat 会折叠成 CommandNode，正好命中本插件已注册的 key=`cmd` 卡片；**client.js 无需改动**这一判断成立。commandId 前缀为 `cmd-terminal-<uuid>`（与 commands 服务的 `cmd-<token>-<seq>` 不同），但 Chat 只按 `String(commandId)` 配对、不校验格式，因此不影响。

### 10.3 用例与命令证据

| 层 | 证据 | 结果 |
| --- | --- | --- |
| backend2 既有单测（新增 8 例） | `tests/terminal.test.mjs:498-636`：顺序/同 commandId/args/transcript、模型输入不变、run 失败、done 失败、followup 抛错补 error done、close 零 append、二次 finish 不重复、无 append 仍成功 | 8/8 PASS |
| tester 独立回归（新增 9 例） | `tests/regression/shell-cmd.test.mjs:381-541`：R36–R44（见 10.1 C1–C10） | 9/9 PASS |
| 全量 | `npm run check` → exit 0；`npm test` → exit 0（**tests 167 / suites 28 / pass 167 / fail 0**）；`npm run verify` → exit 0（167/167） | PASS |

> 说明：R44 是**源码锁定（regression lock）**，只断言源码文本中的事件形状/best-effort/close 边界，不是行为验证；行为由 R36–R43 用伪 `session.append` 覆盖。

### 10.4 运行时/视觉待验项（本机无法自动验证，如实标注）

以下**全部未验证**（无浏览器/页面控制通道，且卡片的真实渲染需要 Chat UI）：

1. 真实 UI 中 Ctrl+Enter 后**卡片是否出现**、位置（应在该轮用户/模型消息之前）、顺序、展开/折叠、复制按钮。
2. 卡片的 `cwd`/状态胶囊（success）/正文（transcript）视觉是否正确；长 transcript 是否截断可展开。
3. 刷新页面或重开会话后卡片是否仍在（log-only 持久化依赖 session log 回放）。
4. Esc/点遮罩关闭**不出现卡片**、模型无消息（与 Ctrl+Enter 的差异）。
5. 模型是否正常收到 transcript 并回复（followup 语义未变，但真实链路未抓包）。
6. ~~README 措辞风险~~ **已由 Lead 修正并复核**：README 现写作“`source.kind='shell-command'` 的消息由 Chat 建 context 节点（默认不渲染成普通用户气泡）”“UI 上表现为默认折叠的 Execution requested turn-trigger 通知”。tester 在 dsh Chat 源码中核对到 `turnTriggerDetails()` 对未知 kind 默认 `title='message.trigger.request'`（英文 “Execution requested”）且走 `turn-trigger` 节点，措辞与宿主行为方向一致；**折叠后的真实视觉仍待人工**（见 10.4-1/2）。
7. 时序风险（LOW）：`done` 在 `followup` 之后追加；Chat 按 commandId 跨事件配对，正常应合并成一条节点。若真实 UI 出现“卡片停在执行中/两条卡片”，需回退检查配对时序。

### 10.5 人工复验步骤（交给 Lead/用户，刷新 Host 后执行）

1. 确认插件已重载/重装为 0.3.13，并刷新页面。
2. 新会话输入 `/cmd` → Enter，打开模态；执行两条命令：`pwd`、`echo hi`。
3. 按 **Ctrl+Enter** 发送。
   - 期望：模态关闭；对话中出现**一条终端卡片**（标题、cwd、状态 success、正文含 `$ pwd` 与 `$ echo hi` 及输出）；卡片位置在该轮对话中；模型收到并正常回复（回复内容应能对上这些命令）。
   - 期望：卡片可展开/复制；刷新页面后卡片仍在。
4. 反向验证：再次 `/cmd` → 执行 `echo esc-test` → 按 **Esc** 关闭。
   - 期望：对话中**不**出现任何新卡片、模型无新消息。
5. 反向验证：`/cmd echo draft` 直接发送（不带模态路径）仍渲染既有终端卡片（未受本次改动影响）。
6. 观察浏览器/Electron DevTools Console：无 `slot entry crashed`、无 unhandled rejection。

### 10.6 本次增量裁定

| 字段 | 值 |
| --- | --- |
| **裁定** | **PASS（含未覆盖项）** —— 事件契约、顺序/配对、失败容忍、close 不追加、模型输入不变均有单测+独立回归+宿主源码核对证据；`npm run verify` 167/167 全绿；GitHub 重装后的运行时核查见 10.7（Host PASS / client 三槽 PASS：tester 通道超时，Lead 代跑原文） |
| CRITICAL/HIGH 失败项 | 无 |
| 未覆盖项 | 10.4 的 1–7（真实 UI 卡片渲染/顺序/持久化、Esc 差异、模型真实回复、README 措辞、跨事件时序），全部需要人工复验 |
| MEDIUM/LOW 残留 | ① ~~README 措辞~~ 已修正并核对（见 10.4-6）；② append 为同步调用（dsh 现实现如此），若未来 dsh 改为异步需重新评估 best-effort；③ `commandId` 前缀与 commands 服务不同但 Chat 不校验格式（已验证） |
| 与 §9 的关系 | §9 是对 0.3.12 三修复的验收记录；本节是 0.3.13 增量验收。§9.6/E7、§9.8 人工待验项（6）中“Ctrl+Enter 后不应有卡片”的旧期望已被本节取代 |

### 10.7 GitHub 重装后运行时核查（task-8 步骤 5）

> 发布/安装由 Lead 执行；tester 独立复核了可读的安装事实。`plugin_manager` 在 tester 委托沙箱中仍被权限拒绝（不重试），fiber 状态使用 Lead 代跑原文并注明；client inspector 由 tester 实跑（结果见下）。

| ID | 结果 | 证据 / 原始返回 |
| --- | --- | --- |
| R1 发布 | **PASS（tester 独立复核）** | 工作区 `git status -sb` → `## main...origin/main`（干净）；HEAD = `22657d587da560319ca02db26e02451d10e913b5`；`git ls-remote origin main` = 同一 sha；提交 `22657d5 feat: 交互终端 Ctrl+Enter 发送后在对话里保留命令行卡片` 的 stat 显示**未改 `client.js`**（terminal.js/tests/docs/package only） |
| R2 安装 | **PASS（tester 独立复核）** | `~/.dsh/profiles/desktop/package.json:20` = `https://codeload.github.com/xx529/dsh-shell-cmd/tar.gz/22657d587da560319ca02db26e02451d10e913b5`；bundles 含 `dsh-shell-cmd`；`node_modules/dsh-shell-cmd/package.json` version=`0.3.13`；`terminal.js` sha256 工作区=安装目录=`7a6f85a1…36a9cd`；`README.md`、`package.json` sha256 亦一致 |
| R3 Host fiber | **PASS（Lead 代跑；tester 无权限）** | Lead 原文：`plugin_manager` offset=200 行 `{"entryId":"include:shell-cmd","moduleName":"dsh-shell-cmd","enabled":true,"fiberPhase":"active","patchId":"shell-cmd"}`；Lead 已执行 `set_plugin include:shell-cmd enabled=false → true`（均 applied） |
| R4 host Config | **PASS（tester 实跑）** | `cordis_inspect_query` host `Config.listConfigs {"name":"dsh-shell-cmd"}` 返回 `{"entries":[{"id":"include:shell-cmd","patchId":"shell-cmd","name":"dsh-shell-cmd","status":"absent"}],"total":1,"nextOffset":null}`（absent=无 schema，不作 fiber 判据） |
| R5 client 三槽 | **PASS（Lead 代跑；tester inspector 超时）** | tester 实跑 `Slots.listSubTree` 三个 root 均返回 `Client inspect query ... timed out after 10000ms`，client `Service.listService` 同样超时（tester 委托通道整体不可用，已如实记录）。Lead 在 Host 重载后实跑成功，原文：`conversation.input.overlay` → occupant `{"registrant":"Gb","id":"shell-cmd-terminal","order":20,"priority":0,"active":true}`；`conversation.composer.dock` → `{"registrant":"Gb","id":"shell-cmd-hint","order":20,"priority":0,"active":true}`；`conversation.chat.commandview` → `{"registrant":"Gb","key":"cmd","priority":0,"active":true}` |
| R6 client bundle 版本 | **PASS（间接）** | client.js 本轮零改动（提交 stat 证明），inspector 也无法读取 bundle 版本号；R5 三槽 active 证明 client 端注册代码仍在运行。0.3.13 的 Host-only 行为（卡片事件）与 client 版本无关 |

**运行时核查结论**：Host 侧 **PASS**（fiber active + 安装产物一致）；client 三槽 **PASS（Lead 代跑，R5 原文）**——tester 侧 client inspector 通道超时的问题已由 Lead 交叉复核，`shell-cmd-terminal` / `shell-cmd-hint` / `commandview key=cmd` 均 active。0.3.13 是 **Host-only 变更**（`client.js` 零改动，已由提交 stat 证明），与 client 注册状态无冲突。

**最终裁定（task-8 / 0.3.13）**：**PASS（含未覆盖项）** —— 事件契约/顺序/配对/失败容忍/close 不追加/模型语义不变均有单元测试（backend2 8 例）+ 独立回归（tester 9 例）+ dsh 宿主源码核对证据；全量 167/167 全绿；GitHub 重装后 Host fiber active、安装产物一致、client 三槽 active。未覆盖（需人工）：真实 UI 卡片渲染/位置/顺序/展开/复制、刷新或重开会话后的持久化回放、Esc 不产卡与 Ctrl+Enter 的差异、模型真实收到 transcript 并回复（见 10.4、10.5）。若人工复验发现卡片缺失/重复/停在执行中，应回退为 FAIL。
