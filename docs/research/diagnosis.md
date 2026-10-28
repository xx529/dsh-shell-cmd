# dsh-shell-cmd 三个 bug 的诊断取证（只读取证，不做实现）

- 取证者：scout（只读，唯一写作用域 `docs/research/**`）
- 取证时间：2026-10-28 09:20–09:55（Asia/Shanghai）
- 运行时：DeepSeek Harness 0.2.1-rc.3（Electron，`/Applications/DeepSeek Harness.app`），profile = `desktop`
- 关键前提：**当前正在运行的 Host 代码 = profile 里已安装的 `dsh-shell-cmd@0.3.11`（codeload tarball），不是工作区代码**。工作区 `index.js` / `client.js` 在取证期间正被 frontend/backend 改写（mtime 09:34/09:35），两者已不一致（`diff -q` 报 differ）。本文所有"旧实现"结论都引用 profile 副本，并注明行号。

## 0. 证据来源与复现方式

| 编号 | 来源 | 取法 |
| --- | --- | --- |
| E1 | `app.asar` 主进程代码 `/lib/main.js` | `python3 /tmp/asar.py extract /lib/main.js /tmp/scout/main.js`（13197 行）；下文行号均为该抽取副本行号 |
| E2 | `app.asar` 内的 Web 前端 `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` | `python3 /tmp/asar.py extract /dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js /tmp/scout/webapp.js`（941,436 B，单行 minified，用 grep 截取片段） |
| E3 | 已解包核心客户端包 | `/tmp/dsh-src/@deepseek-ai/dsh-client-ui-commands/lib/client.js`、`.../dsh-client-ui-conversation/lib/client.js`、`.../dsh-client-ui-renderer/lib/client.js`（由 Lead 预先解包） |
| E4 | 运行中的插件本体 | `~/.dsh/profiles/desktop/node_modules/dsh-shell-cmd/index.js`、`.../client.js`、`~/.dsh/profiles/desktop/node_modules/dsh-shell-cmd/package.json` |
| E5 | 对照插件 | `~/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js`、`~/.dsh/profiles/desktop/node_modules/dsh-capability-settings/lib/client/composer-skills.js`、`~/.dsh/profiles/desktop/node_modules/dsh-terminal-panel/lib/index.js` |
| E6 | asar 内核心 Host 包 | `python3 /tmp/asar.py extract <pkg>/lib/index.js /tmp/scout/asar/...`（dsh-host-webserver、dsh-client-connection、cordis、dsh-api-terminal-controller、dsh-desktop-host） |
| E7 | 真实运行探针 | 本机 curl / lsof；用户报错原图（附件 `sha256:0fd3e983af40b78b174afb6dbc77262a3bab3f1d32ed563bef11b68e1c3bdd39`）；会话日志（zstd 解压） |
| E8 | dsh 自身 Inspect 通道 | `cordis_inspect_query`（host `Service` / `Config`；client `Slots`） |

运行时事实（E7）：

```
$ lsof -nP -iTCP -sTCP:LISTEN | grep -E "3055|52785|9222"
Google     8796  lzx ... 127.0.0.1:9222 (LISTEN)          # Google Chrome，不是 DSH
DeepSeek  17324  lzx ... 127.0.0.1:3055  (LISTEN)         # 同进程：配对 token 服务
DeepSeek  17324  lzx ... 127.0.0.1:52785 (LISTEN)         # 同进程：dsh web Host（webServer）
$ lsof -p 17324 | head -2
DeepSeek 17324 lzx cwd DIR ... /Users/lzx/.dsh/profiles/desktop
DeepSeek 17324 lzx txt REG ... /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness
```

即：Electron 主进程 pid 17324 **在进程内**跑着 dsh Host，Host 的 `webServer` 监听 52785；3055 是另一个服务（`GET /` 返回 `{"error":"Pairing token required"}`）。

---

## 1. 已证实（代码级 / 可复现探针）

### C1 桌面页面 origin 是 `dsh-app://app`，非静态路径全部转发到 Host

证据（E1）：

- `main.js:7009` `const SCHEME = "dsh-app";`
- `main.js:12134` `const applicationUrl = \`${SCHEME}://app/\`;`，`main.js:12288/12312/12940/13045` 用 `navigateMain(applicationUrl)` 加载主窗口。
- `main.js:12406-12414`：

```js
protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname === "shell") return serveWebDocument(...);
    if (url.hostname === "app") {
        if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/") || [...].includes(url.pathname))
            return serveWebDocument(request, join(resources.dsh, "node_modules/@deepseek-ai/dsh-web-frontend/dist"));
        if (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0) return Promise.resolve(new Response(null, { status: 503 }));
        return forwardWebRequest(request, hostUrl, hostCookie);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
});
```

- `main.js:8268-8314` `forwardWebRequest(request, host, cookie)`：
  - `main.js:8271`：`if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });`（页面同源 POST 携带的 `Origin: dsh-app://app` 被放行）
  - `main.js:8278-8285`：删除 `host/origin/cookie/sec-fetch-site` 后 `headers.set("cookie", cookie)`（**注入 Host 认证 cookie**）。
  - `main.js:8286-8295`：`init = { method, headers, body, signal, duplex:"half", redirect:"manual" }` → **POST、body、`content-type` 全部原样转发**（只删上述 4 个头）。
  - `main.js:8295-8313`：返回 Host 响应，但 `WITHHELD_RESPONSE_HEADERS`（`main.js:8243`，含 `set-cookie`）被剔除，页面拿不到 Host cookie。
- `main.js:8243` 上方注释确认：Host cookie 由"shell 拥有"，不下发给页面 cookie jar。

结论：`dsh-app://app` 下任何**相对**请求都会被转发到 `http://127.0.0.1:52785/<path>` 并注入认证 cookie，方法/体/`content-type` 保持。

### C2 `__DSH_TRANSPORT__ = { ownsHost:true, streamBaseUrl: <Host origin> }`

证据（E2，`/tmp/scout/webapp.js` 单行，grep 片段）：

```js
Ls.ready().then(async({injections:i,streamBaseUrl:n})=>{
  const s=globalThis;
  s.__DSH_TRANSPORT__={ownsHost:!0,streamBaseUrl:n};
  await UZ(i, ...)
})
```

服务端来源（E1）：`main.js:12424-12431` `ipcMain.handle(DESKTOP_IPC.boot, ...)` 返回 `{ injections, streamBaseUrl: new URL(hostUrl).origin }`（**origin，无尾斜杠**）。

结论：`streamBaseUrl` 是 `http://127.0.0.1:52785`（绝对 origin），不是相对前缀。

### C3 旧 client 把 RPC 拼成绝对跨源地址 → `TypeError: Failed to fetch`

证据（E4，运行中的 profile 副本）：

`~/.dsh/profiles/desktop/node_modules/dsh-shell-cmd/client.js:569-589`：

```js
const TERMINAL_RPC = 'api/cmd-terminal/rpc'
function terminalEndpoint() {
  const transport = globalThis.__DSH_TRANSPORT__
  const base = (transport?.streamBaseUrl?.length > 0) ? transport.streamBaseUrl : document.baseURI
  if (base.length > 0) return new URL(TERMINAL_RPC, base).toString()   // ← 绝对 http://...
  return TERMINAL_RPC
}
```

`client.js:631`：`const response = await fetch(terminalEndpoint(), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) })`。

`new URL('api/cmd-terminal/rpc', 'http://127.0.0.1:52785')` = `http://127.0.0.1:52785/api/cmd-terminal/rpc`。从 `dsh-app://app` 页面发起属于跨源请求；Host `/api` 响应不带 CORS 头，浏览器直接拒绝，`fetch` 抛 `TypeError`，消息即 `Failed to fetch`（该消息被面板错误区原样展示）。

运行证据（E7，用户原图）：终端面板输出区红字 **`Failed to fetch`**，输入框仍是 `/cmd `，面板是普通大块区域而非居中模态。这与上面的 TypeError 文案、claim 阶段打开逻辑完全对应。

### C4 对照实现：dsh-context 用页面相对地址，同一 `/api` 桥

`~/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js`（minified，grep）：

```
fetch(`api/dsh-context/attachment`,{method:`POST`,headers:{"content-type":`application/json`},...})
fetch(`api/dsh-context/backfill`,{method:`POST`})
fetch(`api/dsh-context/skills`,{method:`POST`,...})
fetch(`api/dsh-context/detail`...    // 变量 sr=`api/dsh-context/detail`
```

无任何 `streamBaseUrl`/绝对化。用户诉求原文是"像 `/context` 这样弹出"，说明该插件在当前安装里工作正常 → 相对地址 + `/api` 精确路由是被运行验证过的通道。

### C5 `/api` 精确路由的 Host 侧契约与注册时机

契约（E8，`cordis_inspect_query` host `Service` `service=connection`）：

```ts
export interface HostConnectionFetch {
  register(route: ConnectionFetchRoute): () => Promise<void>;
}
export interface ConnectionFetchRoute {
  readonly path: string;                        // 必须落在 /api/ 下
  readonly methods: readonly ('GET'|'HEAD'|'POST')[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}
```

实现（E6，`/tmp/scout/asar/dsh-client-connection/lib/index.js`）：

- `registerFetchRoute(owner, route)`（约 835-853 行）：`assertFetchRoute(route)` 后把 route 放入**内存 Map `this.fetchRoutes`**；路由表是活表，晚注册也能被后续请求命中。
- `createSharedFetchHandler(channel)`（820-833 行）：请求到来时按 `url.pathname` 查 `fetchRoutes`，命中且方法匹配就用 `route.fetch`；否则走 `/api` 拦截器或 404。
- `apply()`（1022-1060 行）：`ctx.inject(["webServer"], (webCtx) => { ... const fetchHandler = connection.createSharedFetchHandler(API_PATH); webCtx.effect(() => webCtx.webServer.register({ kind:"prefix", path:"/api", handler: ... })) ... })` —— `/api` 前缀路由由 connection 自己等 `webServer` 就绪后挂上。
- `assertFetchRoute` 要求 `endpointFromPath("/api", route.path) !== undefined`，即插件注册的 `'/api/cmd-terminal/rpc'` 合法。

插件侧（E4，已安装 `index.js:469-488`）：

```js
ctx.inject(['connection'], (child) => {
  const service = child.get('connection')
  const fetchRoutes = service?.fetch
  ...
  fetchRoutes.register({ path: TERMINAL_FETCH_PATH /* '/api/cmd-terminal/rpc' */, methods:['POST'], requestBody:'buffered', fetch: route })
  terminalRouteReady = true
})
```

结论：该注册写法与契约逐字匹配；`ctx.inject` 会等 `connection` 就绪后执行，因此 `/api/cmd-terminal/rpc` 的注册**不依赖 apply 时的服务可见性**。

### C6 `webServer` 根路径 `/cmd-terminal/rpc` 当前确实未注册（运行探针）

对 52785（Electron 内 dsh Host）逐一探测：

| 方法+路径 | 结果 |
| --- | --- |
| `GET /` | 401 `dsh web authentication required; reopen the URL printed by dsh web.` |
| `GET /cmd-terminal/rpc` | **404** |
| `POST /cmd-terminal/rpc` | **405** |
| `GET /terminal-panel/rpc` | **401** |
| `POST /terminal-panel/rpc` | **401** |
| `GET /totally-nonexistent-xyz` | 404 |
| `POST /totally-nonexistent-xyz` | 405 |
| `GET /api/cmd-terminal/rpc`、`POST /api/cmd-terminal/rpc`、`POST /api/nonexistent` | 全部 **401** |
| `GET /assets/index.js` | 404；`POST` → 405 |

解读：

- 未注册路径走 fallback → GET 404 / POST 405；`/cmd-terminal/rpc` 与"完全不存在"同构 ⇒ **没有进入 webServer 的 exact 路由表**。
- `/terminal-panel/rpc` 返回 401 ≠ 404/405 ⇒ 该路径**已在路由表中**，handler 主动拒绝了未认证请求。对照插件 `~/.dsh/profiles/desktop/node_modules/dsh-terminal-panel/lib/index.js:33` 声明 `export const inject = ['webServer','connection']`，并在 `apply` 里 `webServer.register({...})`（同包 92 行）。⇒ webServer 路由 API 在本运行时可用，且**声明了 `inject` 的插件能拿到 webServer**。
- `/api/*` 的 401 是 `connection.admit(req)` 在**路由选择之前**执行的认证栅栏（dsh-client-connection:1044-1052），因此 curl 401 **不能**用来判断 `/api/cmd-terminal/rpc` 是否注册，也不能判 404。

### C7 commands 客户端语义：bare 调用只产生 leadingInput claim；decorate 的 action 先消费 token 再执行

证据（E3，`/tmp/dsh-src/@deepseek-ai/dsh-client-ui-commands/lib/client.js`）：

- `1470-1485` `decorate(decoration)`：注册到 `this.live.decorations`（按命令名去重），返回 disposer；decoration 形状由使用处决定 = `{ name, available(session), ui }`。
- `1624-1682` `matchEnter(session, line, signal, envelope)`：
  - `1645-1653`：contribution（插件自注册命令）命中 → `invoke(...)`；
  - `1654-1668`：`await this.directory.ensureReady(...)` 后解析 Host 命令；
  - `1665-1678`：**bare 调用**（无参数）且存在 decorative 且 `decoration.available(session)` → `this.invoke(name, decoration.ui, session, { via:"enter", token })` 并 `return "handled"`；
  - `1683-1690`：若命令 `desc.input !== undefined`（`/cmd` 正是带 input 的 Host 命令）→ 返回 `{ claim: this.leadingClaim(...) }`（**不执行，草稿保留 token，等待第二次 Enter 提交参数**）。
- `1683-1697` `invoke(name, ui, session, segment)`：

```js
if (ui.kind === "action") {
    this.consumeVia(session.sessionId, segment);   // ← 先消费 token
    ui.run(session);                               // ← 再执行回调
    return;
}
```

- `1769-1783` `consumeVia(id, segment)`：`actx.bail(actx, "slash/input-consume-token", { guard: { kind:"bare-token", token } })`，返回值被忽略。
- `run(session)` 收到的 session 至少含 `sessionId`（`1694`、`1579`、`1709` 等都用 `session.sessionId`）；`available(session)` 同样收到该 session 对象（`1570/1666`）。仓库内现成写法：`dsh-client-ui-conversation/lib/client.js:19884-19892` 的 `available:(session)=>inputHub.canPickFiles(session.sessionId)`、`ui:{kind:"action", run:(session)=>{...session.sessionId}}`。

"草稿自动清空"已证实（E3 + 同包对话侧）：

- `dsh-client-ui-conversation/lib/client.js:15863`：`actx.on("slash/input-consume-token",(req)=>shell.consumeToken(req.guard)?true:void 0)` —— 同步监听。
- 同文件 `15353-15368` `consumeToken(guard)`：

```js
if (guard.kind === "span") { ... return this.draftEditor.replaceText(guard.span, ""); }
if (guard.token === "" || this.projection.clipboardText.trim() !== guard.token) return false;
this.setDraft("");     // ← bare-token 命中后清空草稿
return true;
```

结论：给 `cmd` 挂 `ui.kind === 'action'` 的 bare 装饰后，第一次 Enter 就会 `consumeVia`（清空 `/cmd` 草稿）再 `run(session)`；不产生消息提交，也**不会再落到 leadingInput claim**。

### C8 `conversation.input.overlay`：session 作用域、`inject(sessionId, actions)` 注入自定义 props、标准 `useInput`/`inputActions`

证据（E3）：

- 槽声明：`dsh-client-ui-conversation/lib/client.js:20085-20088` `"conversation.input.overlay": { kind:"list", scope:"session" }`；父槽 `conversation.composer.bar` 为 `session-maybe`。渲染点：同文件 `19180-19185`，`InputBar` 内部 `data-composer-overlay` 锚点里 `renderSlot("conversation.input.overlay", {})`。
- 标准 props 来源：同文件 `19897-19915`：

```js
ctx.uiSession.provide({
  hooks: ["conversation", "input"],
  props: ["inputActions"],
  resolve: (binding) => ({ hooks: { conversation: conversation.snapshot, input: shell.state },
                           props: { inputActions: shell.actions } })
})
```

- `inputActions` 方法集：同文件 `14936-14960`（`SessionInputShell.actions`）= `captureInsertion()`、`insertText(text, span)`、`setDraft(text)`、`persistDraft()`、`addAttachments(ids)`、`removeAttachment(id)`、`pruneAttachments(ids)`、`submit()`。
- 现成插件用法（E5，`dsh-capability-settings/lib/client/composer-skills.js:26-31` 注释 + `172` 行组件 + `225-235` 行实现）：明确写「`conversation.input.overlay` 是 session 作用域槽，ui-conversation 的 provide 贡献（hooks: `["input"]`、props: `["inputActions"]`）会把 `useInput` / `inputActions` 注入条目 props；追加草稿只调 `inputActions.setDraft(完整新草稿)`（输入机的唯一公开写路径）」；Esc/关闭场景可 `setDraft('')` 清残留。
- 自定义 props 注入链（E3，`dsh-client-ui-renderer/lib/client.js`）：
  - `435-445` `runInject(entry, binding, actions)`：`const args = []; if (binding !== undefined) args.push(binding.key); if (actions !== undefined) args.push(actions); return bindInjectSources(inject(...args));` —— `binding.key` 即 sessionId。
  - `447-465` `bindInjectSources`：返回值里的 `hooks` / `keyedHooks` 会被改写成标准 hook props（如 `hooks:{ contextModal }` → `useContextModal`），其余键原样成为 props。
  - `507-519` `cachedSessionInject(entry, binding, actions)` + `811-816` `SessionEntry`：session 作用域条目渲染时按 (entry, binding) 记忆化注入结果。
- dsh-context 同槽用法（E5，minified 单行，grep 片段）：

```js
e.slots.inject(`conversation.input.overlay`,()=>e.slots.register({
  name:`conversation.input.overlay`, id:`context-modal`, order:10, locale:wp,
  inject:(e=``)=>({ hooks:{ contextModal:O(e) } })          // e = sessionId
}, e=>(0,u.createElement)(c,e)));
```

- 模态样式（同文件 CSS 片段）：`.lc-modal-backdrop{z-index:200;background:var(--dsw-alias-bg-mask-1,#00000073);justify-content:center;align-items:center;display:flex;position:fixed;inset:0}` —— 即 `/context` 式居中遮罩模态的现成实现方式。

结论：把交互终端从 `conversation.input.dock` 改注册到 `conversation.input.overlay`，用 `inject:(sessionId)=>({...})` 注入自定义 props 或直接接收标准 `useInput`/`inputActions` 都合法；`inputActions.setDraft('')` 是清草稿的公开路径。

### C9 运行中的旧 client 没有 commandUi 装饰，也没有 overlay 模态

`grep -n "commandUi\|decorate\|input.overlay" ~/.dsh/profiles/desktop/node_modules/dsh-shell-cmd/client.js` → **无命中**。旧实现只注册 `conversation.chat.commandview`、`conversation.composer.dock`（提示条）、`conversation.input.dock`（终端面板），且终端面板在 **claim 阶段**（`claimName === 'cmd' && draft.trim() === '/cmd'`）就 `setTerminalOpen(true)`（同文件约 880-890 行附近）。这解释了用户原图：面板已经打开、草稿仍是 `/cmd`、错误是 `Failed to fetch`；Esc 关闭后 claim 副作用仍会把面板重新打开（bug 3），草稿也无人清理（bug 2 的一半）。

### C10 `dsh.client.inject` 的语义（模块到达顺序依赖）

`/tmp/dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js`：

- `64-73` `parseDshClient()` 读取 `pkgName` 的 `dsh.client.{platform,inject,external,immediately}`；
- `788-795` `arriveGraphRow(row)`：「Register each injected package ... before its consumer」，即 `row.inject` 里的包先到达、再加载本包；依赖加载失败则消费者不加载（`798-806` 报 `"<consumer>" not loaded because dependency "<dep>" failed`）。
- 因此若插件 client 要使用 `commandUi` 服务，`package.json` 的 `dsh.client.inject` 应加入 `"@deepseek-ai/dsh-client-ui-commands"`（当前 E4 `package.json` 只有 `dsh-client-ui-conversation`、`dsh-client-locale`）。这只是**加载顺序/依赖声明**要求，不是运行时鉴权。

### C11 用户报错原图（运行时证据，非模型伪造）

- 附件：`/Users/lzx/.dsh/attachments/v1/objects/0f/0fd3e983af40b78b174afb6dbc77262a3bab3f1d32ed563bef11b68e1c3bdd39`（PNG 1632×531）
- 内容：`交互终端 cwd …` 面板，输出区红字 `Failed to fetch`，命令行已有 `ls`，输入框残留 `/cmd`，面板为通栏大块而非居中模态。
- 与该用户的原始报障文本一致（会话日志 `~/.dsh/sessions/--Users-lzx-Documents-GitHub-dsh-shell-cmd--/session-7f588c4c-d8ee-458c-ad4d-99fe721c12aa/session.v4.jsonl.zstd` 解压后的 `user/message` 事件，seq 9）：

> 1. 输入 /cmd 后弹出命令卡片存在 faile to fetch 的报错
> 2. 我希望输入 /cmd 按回车后弹出的命令卡片会类似 /context 这样弹出，并背景略有模糊，并且按 esc 取消后，对话框输入没有残留 /cmd 的文本
> 3. 当前弹出 命令行卡片后 无法关闭

---

## 2. 推断（有代码/探针支撑，但缺直接运行时观测）

### I1 根路径 `/cmd-terminal/rpc` 未注册的最可能原因：apply 时 `webServer` 尚未就绪（boot-order），且没有重试

- 事实链：
  1. 运行中 `index.js:36`：`export const inject = ['commands','shell','workingDirectory']` —— **没有** `webServer`/`connection`，所以该 fiber 只在三者就绪时启动，不等待 webServer。
  2. `index.js:461-462`：`const webServer = optionalService(ctx, 'webServer')`（内部 `ctx.get(name)`），只在 apply 时读一次；`490-503` 据此决定是否 `webServer.register({kind:'exact', path:'/cmd-terminal/rpc', handler})`。
  3. cordis（E6，`/tmp/scout/asar/cordis/lib/index.js:756-767`）：`ctx.get(name, strict=true)` 只在 `impl.fiber.state === 2`（已激活）时返回值，否则 `undefined`；`optionalService` 又会吞掉异常。
  4. 运行探针（C6）：该 exact 路由不在路由表（404/405）。
  5. 同层插入的 `dsh-terminal-panel` 声明了 `inject:['webServer','connection']`，路由在（401）。
- 因此最可能：shell-cmd 的 apply 先于 webServer fiber 激活执行，`ctx.get('webServer')` 返回 `undefined`，`if (...register === 'function')` 分支被跳过；没有 `inject`/`ctx.inject(['webServer'])` 就没有补注册机会。
- 备选解释（弱）：代码注释猜测 `connection` 可能在 web-app 的隔离 realm/子上下文。但 `terminal-panel` 与 shell-cmd 都是 profile 根下的同级 bundle insert，`terminal-panel` 能拿到服务，说明 realm 不是障碍；且 cordis 的 `inject` 解析走全局 reflect store（`_checkImpl`，cordis:1094-1110），与父子层级无关。故不采信 realm 说。
- **该根路径已无必要**：client 走的是 `/api` 精确路由；根路径只是"手工回退"。

### I2 `/api/cmd-terminal/rpc` 很可能已注册，相对地址修法应能跑通

- 事实链：`ctx.inject(['connection'], ...)` 是 cordis 的 functional inject（cordis:1600-1606 `inject(inject, callback) => plugin({inject, apply: callback})`；依赖就绪时 `_checkImpl/_refresh` 触发 fiber 激活，cordis:1094-1110、827-843），不受 apply 时序影响；`connection.fetch` 的路由表是活 Map（C5），晚注册也会被后续请求命中。
- 间接运行证据：同款 `/api` 相对地址的 `dsh-context` 在当前安装里可用（用户以 `/context` 为参照）。
- **但未直接观测**：`/api/*` 的 401 认证栅栏先于路由选择（C6），curl 无法区分"未注册"与"已注册但未认证"；客户端 inspect 也不可用（见 U1）。
- 验证方法（修法实施后）：刷新页面，在 Web 前端 DevTools Network 看 `POST dsh-app://app/api/cmd-terminal/rpc` 的响应（应为 200 JSON，而不是 401/404/`Failed to fetch`）；或 Host 日志出现该路径 200。

### I3 `Failed to fetch` 的触发面不止面板：dock 轮询也会打同地址

旧 dock 组件的轮询 effect 在面板关闭时按 1.2s（/8s 内 180ms 快速）反复 `terminalRpc(sessionId,'status')`（E4 client.js 约 880-940 行）。即使面板没打开，只要会话存在，就会周期性向绝对跨源地址 POST，控制台会持续刷 `Failed to fetch`。修正为相对地址后，这条轮询才会真正生效（Host `status.pendingOpen` 兜底打开）。修法必须同时保留"不伪造成功"的语义：轮询失败仍静默重试。

---

## 3. 未验证（明确无法在此会话内证明）

### U1 真实 UI 自动化/截图通道：不可用（逐项结论与原因）

| 通道 | 结论 | 证据/原因 |
| --- | --- | --- |
| Electron CDP（`--remote-debugging-port`） | **不可用** | `lsof -nP -iTCP -sTCP:LISTEN` 只见 3055/52785 属于 pid 17324，无 9xxx 调试端口；唯一 9222 属于 Google Chrome（pid 8796），且 `curl http://127.0.0.1:9222/json/version` 返回 `HTTP/1.1 404 Not Found`、`Content-Length:0`，不是 DevTools 协议端点。且 Chrome 的 CDP 也驱动不到 Electron 窗口。 |
| GUI 认证 token / cookie（外部 curl 驱动 Host） | **不可用/不可得** | 页面认证 cookie 由 Electron 主进程在 `authenticateWebHost(hostUrl)` 里换取（`main.js:8229-8240`：`fetch(url,{redirect:'manual'})`，要求 303 + `set-cookie`），`hostUrl` 是进程内 Host 报告的内部 URL（含一次性 token）；`forwardWebRequest` 又刻意从响应中剔除 `set-cookie`（`main.js:8243`、8305-8313），页面 cookie jar 拿不到。本机 `~/.dsh` 常见状态目录/日志未发现持久化的 host token；所有 `/api/*` 外部请求因此恒 401。 |
| Playwright / 浏览器 MCP | **对真实 UI 不可用** | 工具存在，但它是独立浏览器上下文，不是运行中的 Electron 窗口；访问 `http://127.0.0.1:52785/` 需要启动 token（返回 401 `dsh web authentication required`），无法登录。 |
| macOS Computer Use（open-computer-use MCP） | **尝试后失败** | `list_apps` 能找到 `DeepSeek Harness — com.deepseek.dsh [running]`；但 `get_app_state`（`app` 分别为 `com.deepseek.dsh` 与 `DeepSeek Harness`，`window_placement=keep`）均返回 `Error Domain=NSPOSIXErrorDomain Code=2 "No such file or directory"`。原因未定位（helper/辅助功能权限/会话环境限制），因此**不能**用它读取实时窗口做截图/AX 校验。 |
| dsh 自带 Client Inspect（`Slots.listSubTree`） | **本次不可用** | 对 `conversation.input.dock`、`conversation.chat.commandview` 两次查询均 `timed out after 10000ms`，提示 "Open or reconnect the Harness page, then retry"。无法借此确认 occupant。 |
| Host Inspect（`Service`/`Config`） | **可用（有限）** | `Service` 返回 Host 服务契约目录（可确认 `webServer`、`connection`、`HostConnectionFetch.register` 契约）；`Config.listConfigs name=dsh-shell-cmd` 返回 `include:shell-cmd` 且 `status:"absent"`——该 status 是 **Config schema 状态**（无 Config 导出），**不是** fiber 运行状态，不能据此判断插件是否 active。 |

替代验证方式（建议 tester/Lead 采用）：

1. **真实用户手动复验**：刷新页面 → `/cmd` 回车 → 观察是否居中模态、遮罩模糊、Esc 后输入框为空；由用户确认截图（当前唯一真实 UI 证据源）。
2. **Host 侧可观测行为**：修法合入后，`/api/cmd-terminal/rpc` 的 `status` 轮询会成功；可在会话日志中看到裸 `/cmd` 的 `command/run`/`command/done`（log-only）与 `agent.followup` 只在 Ctrl+Enter 出现（会话日志为 zstd，可用 `zstd -dc` 解压后 grep）。
3. **前端可做的静态契约断言**：`grep -n "streamBaseUrl" client.js` 应无命中（或仅保留在非 RPC 用途）；`TERMINAL_RPC` 必须是相对常量；`conversation.input.overlay` 注册存在；`commandUi.decorate` 调用存在。注意：静态断言 ≠ 视觉验证，不能替代第 1 条。

### U2 `/api/cmd-terminal/rpc` 是否已在运行 Host 注册（直接观测）

见 I2。只能给出"契约正确 + 机制允许晚注册 + 同款插件工作"的强推断，不能给出直接 200/404 观测（401 栅栏先行）。

### U3 修法后的真实视觉/交互（模态层级、模糊、Esc 焦点）

无法在当前会话内驱动 Electron 页面验证；需要用户刷新页面后人工确认。不得用 mock 页面/截图伪造。

---

## 4. 推荐修法对照（只给落点与契约，不写产品代码）

> 说明：以下与 AGENTS.md 最新约定一致；工作区代码正由 frontend/backend 修改，本表只列"改哪里 + 依据"。

| # | 问题 | 修法落点（运行中旧代码位置） | 依据 |
| --- | --- | --- | --- |
| 1 | `Failed to fetch` | `client.js:569-589` 删掉 `terminalEndpoint()` 的 `__DSH_TRANSPORT__.streamBaseUrl` / `document.baseURI` 绝对化，`TERMINAL_RPC` 直接用页面相对地址 `'api/cmd-terminal/rpc'`；`client.js:631` 的 `fetch(...)` 保持不变（相对地址由页面 base 解析为 `dsh-app://app/api/...`，被 `protocol.handle` 转发到 Host 并注入 cookie） | C1/C2/C3/C4；`main.js:12406-12414`、`8268-8313`；dsh-context 同款 |
| 2 | 类 `/context` 模态 + Esc 清残留 | ① `client.js` 把终端面板从 `conversation.input.dock` 改注册到 `conversation.input.overlay`（`size=session`），用 `inject:(sessionId)=>({...})` 注入自定义 props 或用标准 `useInput/inputActions`；渲染 `position:fixed;inset:0;z-index:200` 遮罩 + `backdrop-filter:blur(3px)`，点遮罩关闭、卡片内 `stopPropagation`；② Esc/关闭路径若草稿仍为 `/cmd`，调 `inputActions.setDraft('')` | C8（overlay 声明/注入链/方法集）+ dsh-context 的 `.lc-modal-backdrop` 现成写法 |
| 3 | 裸 `/cmd` 立即打开 + 关不掉 | 删除 dock 里"claim 阶段 `setTerminalOpen(true)`"的 effect（旧 client.js 约 880-890 行）；改为 client 侧 `ctx.inject(['commandUi'])` → `commandUi.decorate({ name:'cmd', available:()=>true, ui:{ kind:'action', run:(session)=>open(session.sessionId) } })`，让第一次 Enter 走 `consumeVia`（清 token、不提交）再 open；`package.json` 的 `dsh.client.inject` 增列 `@deepseek-ai/dsh-client-ui-commands`；OPEN_MARKER/status 轮询只保留为兜底，且 `status` 只读 `pendingOpen`（不与 claim 联动） | C7（matchEnter/invoke/consumeVia + 草稿清空）+ C10（dsh.client.inject 依赖顺序） |
| 4 | 根路径路由 | 删除 `index.js:461-462`、`490-503` 的 `webServer` 分支与 `createTerminalRpcHandler`/`TERMINAL_ROUTE`（本 profile 不可达；且 `ctx.get` 早读导致静默跳过）；只保留 `ctx.inject(['connection'])` + `connection.fetch.register({path:'/api/cmd-terminal/rpc', methods:['POST'], requestBody:'buffered', fetch})`；`isTerminalModeAvailable` 不再要求 `webServer` | C5/C6 + I1/I2；契约见 `cordis_inspect_query` host `Service(connection)` |
| 5 | Host 就绪判定 | 若要更稳：把 `isTerminalReady` 绑定到 `connection.fetch.register` 成功后（现有 `terminalRouteReady` 做法正确），不要用 `optionalService(ctx,'webServer')` 决定可用性 | I1/I2 |

风险提示：

- 相对地址依赖页面 base = `dsh-app://app/`（`applicationUrl`，main.js:12134）。若未来页面改为子路径（如 `dsh-app://app/some/`），相对地址仍正确；但若有人把它改回绝对地址或改 `TERMINAL_RPC` 前缀（去掉 `api/`），跨源/404 会复发。
- `commandUi.decorate` 是**给 Host 命令挂 bare 装饰**：必须确认没有第二个插件给 `cmd` 挂同名 decoration（重复会 throw，`dsh-client-ui-commands:1473-1474`），且 `available` 永远返回可用以避免与 `desc.input` 的 leadingInput 路径竞争。
- `consumeVia` 在 `ui.run` **之前**同步清空草稿（C7）。若 `run` 里异步失败，草稿已消失；需要"失败可恢复"时应在 open 前把 token 存起来（或依赖 OPEN_MARKER 快路径），不要指望草稿还在。
- 删除根路径路由会改变 AGENTS.md 里"手工回退"的说法；文档需同步（当前 AGENTS.md 已由 Lead 更新）。
- `inputActions.setDraft('')` 是公开写路径，但会触发受控重渲染；Esc 路径应在关闭动画/卸载前取好引用，避免在已卸载组件里调用（`composer-skills.js:225-235` 有同类注释：关闭弹层会卸载组件，先取 textarea 引用）。

---

## 5. 与 Lead 既有假设的核对

| Lead 假设 | 本次结论 |
| --- | --- |
| 桌面页面 origin `dsh-app://app`，非静态路径 `forwardWebRequest` 转发 | **成立**（C1；含 cookie 注入、POST/content-type 原样转发，已核） |
| `__DSH_TRANSPORT__.streamBaseUrl = new URL(hostUrl).origin` | **成立**（C2；main.js:12424-12431 + webapp 片段） |
| 旧 client 用绝对地址导致跨源 `Failed to fetch` | **成立**（C3 + C11 用户原图文案） |
| 相对 `api/...` 由页面解析并被转发 | **成立**（C1 + dsh-context 同款 C4；`dsh-app://app/` 下相对 `api/...` → `dsh-app://app/api/...`） |
| Host `connection.fetch` 精确路由可达 | **契约成立、机制允许晚注册**（C5）；但运行时可观测性受 `/api` 401 栅栏限制（U2，未直接验证） |
| 根路径 `/cmd-terminal/rpc` 未注册 | **成立**（C6：GET 404 / POST 405；对照 `/terminal-panel/rpc` 401） |
| 原因"webServer 服务在插件 ctx 不可见" | **修正**：更准确是 **apply 时 webServer 尚未激活（ctx.get strict 返回 undefined）+ 未声明 inject/未重试**（I1）；`terminal-panel` 证明 webServer 对同级插件可见 |
| `connection` 可能在 web-app 子上下文导致拿不到 | **不采信该解释**：cordis inject 解析走全局 store（`_checkImpl`），与层级无关；`ctx.inject(['connection'])` 写法本身正确（I2） |
| `commandUi.decorate` 的 bare action 先命中、consumeVia 清 token 再 run | **成立**（C7；含草稿清空证据 conversation:15353-15368、15863） |
| overlay 的 `inject(sessionId)` / `useInput` / `inputActions.setDraft` | **成立**（C8；renderer:435-445、conversation:19897-19915、capability-settings:26-31） |
| 需要把 `dsh-client-ui-commands` 加入 `dsh.client.inject` | **成立且有必要**（C10：modules 按 `row.inject` 先加载依赖；当前 package.json 未列） |
| Electron CDP / playwright 可用于真实 UI 验证 | **不成立**（U1；无 CDP、token 不可得、computer-use 报错、client inspect 超时） |

---

## 6. 一句话结论

三个用户可见问题各自有独立根因：**① RPC 绝对地址跨源（`Failed to fetch`）**；**② 旧 dock 在 claim 阶段自动打开、Esc 后草稿残留 `/cmd` 被 claim 再次触发（关不掉 + 残留）**；**③ 旧实现没有 commandUi bare action，只能靠 claim/轮询兜底**。修法方向（相对 `api/...` + `commandUi.decorate` action + `conversation.input.overlay` 模态 + 删 claim 自动打开）与 dsh 客户端契约逐条匹配；但真实视觉验证在本机不可自动化，只能由用户刷新页面后人工确认。
