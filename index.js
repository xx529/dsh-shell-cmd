/**
 * dsh-shell-cmd · Host 半端
 *
 * 注册人类 slash 命令 `/cmd <shell 命令>`：
 *   1. 用 `ctx.shell` 在会话工作目录前台执行该命令（带超时与取消）；
 *   2. 把「命令 + 退出状态 + stdout/stderr」作为一条 user 消息交给 `agent.followup()`，
 *      模型在下一轮据此回复；
 *   3. 命令的 `CommandResult.text` 保留同一份输出，浏览器半端用
 *      `conversation.chat.commandview`（key = `cmd`）把它渲染成终端卡片。
 *
 * 该命令是**人类显式输入**，因此默认不套用会话的 model sandbox policy：
 * 等价于用户自己在终端里执行；命令不是模型发起的。
 *
 * 兼容性约定：
 * - 不静态 import 任何 `@deepseek-ai/*` 包。链接安装（plugin_manager install_bundle
 *   本地目录）的插件位于工作区，无法解析 dsh 安装内的核心包；因此 UserMessage
 *   按 `createUserMessage()` 的等价结构就地构造（id / role / content / source）。
 * - 不导出 `Config`，避免依赖 schemastery；可调值以常量导出，必要时再升级。
 *
 * @module dsh-shell-cmd
 */

import {
  OPEN_MARKER,
  TERMINAL_ROUTE,
  TERMINAL_FETCH_PATH,
  createTerminalRegistry,
  createTerminalRpcHandler,
  createTerminalFetchRoute,
} from './terminal.js'

/** Host 插件名（与包名一致，便于日志定位）。 */
export const name = 'dsh-shell-cmd'

/** 依赖的 Host 服务；缺失时插件保持 inactive 而不是抛错。 */
export const inject = ['commands', 'shell', 'workingDirectory']

/** 单条命令的默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 120_000

/** 卡片与模型共用的输出保留上限（字符）。 */
export const DEFAULT_MAX_OUTPUT_CHARS = 24_000

/** 执行器侧单流上限（字节），避免一次命令撑爆 session 日志。 */
export const STDOUT_MAX_BYTES = 256 * 1024

/** `/cmd` 的用法提示。 */
export const USAGE = 'Usage: /cmd <shell command>'

/**
 * 按字符上限截断文本，保留头尾并标明省略量。
 * @param {string} text 原始文本
 * @param {number} max 上限
 * @returns {{ text: string, truncated: boolean }}
 */
export function clipText(text, max) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return { text, truncated: false }
  const head = Math.max(1, Math.floor(max * 0.65))
  const tail = Math.max(0, max - head)
  const omitted = text.length - head - tail
  const body = text.slice(0, head)
  const rest = tail > 0 ? text.slice(text.length - tail) : ''
  return {
    text: `${body}\n… [${omitted} characters omitted] …${tail > 0 ? `\n${rest}` : ''}`,
    truncated: true,
  }
}

/**
 * 合并 stdout / stderr 为一段可直接展示的正文。
 * @param {string} stdout
 * @param {string} stderr
 * @returns {string}
 */
export function composeBody(stdout, stderr) {
  let body = typeof stdout === 'string' ? stdout : ''
  const err = typeof stderr === 'string' ? stderr : ''
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.trim().length === 0) return '(no output)'
  return body
}

/**
 * 把一次已结束的执行结果转成状态标记行。
 * @param {object} result `ShellRunResult`
 * @returns {string[]}
 */
export function statusMarkers(result) {
  const markers = []
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  else if (result.aborted) markers.push('[aborted]')
  else if (result.signal !== null && result.signal !== undefined) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result.exitCode !== 0 && result.exitCode !== null) markers.push(`[exit code: ${result.exitCode}]`)
  if (result.stdout?.truncated || result.stderr?.truncated) markers.push('[some output was truncated by the executor]')
  return markers
}

/**
 * 命令卡片（`CommandResult.text`）的正文：输出 + 状态标记。
 * @param {object} result `ShellRunResult`
 * @param {number} maxOutputChars 文本上限
 * @returns {{ text: string, exitCode: number | null, timedOut: boolean, aborted: boolean }}
 */
export function composeCommandText(result, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const clipped = clipText(composeBody(result.stdout?.text, result.stderr?.text), maxOutputChars)
  const markers = statusMarkers(result)
  let text = clipped.text
  if (clipped.truncated) markers.unshift('[output truncated for display]')
  if (markers.length > 0) {
    if (!text.endsWith('\n')) text += '\n'
    text += markers.join('\n')
  }
  return {
    text,
    exitCode: result.exitCode ?? null,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
  }
}

/**
 * 交给模型的 user 消息正文。
 *
 * 模型只看到这条消息，因此正文必须自带上下文：是谁执行的、命令原文、
 * 工作目录、退出状态，以及完整（或截断后的）输出。
 *
 * @param {object} input
 * @param {string} input.command 用户输入的命令原文
 * @param {string} input.cwd 执行目录
 * @param {object} input.result `ShellRunResult`
 * @param {number} maxOutputChars 文本上限
 * @returns {string}
 */
export function composeModelText({ command, cwd, result, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS }) {
  const clipped = clipText(composeBody(result.stdout?.text, result.stderr?.text), maxOutputChars)
  const markers = statusMarkers(result)
  const exit = result.timedOut
    ? 'timed out'
    : result.aborted
      ? 'aborted'
      : result.signal !== null && result.signal !== undefined
        ? `signal ${result.signal}`
        : String(result.exitCode ?? 0)
  const lines = [
    'The user ran the following shell command from the DSH composer (/cmd). Respond to the user based on the command and its output; the command was not run by you.',
    '',
    `$ ${command}`,
    `cwd: ${cwd}`,
    `exit: ${exit}`,
    '',
    clipped.text,
  ]
  if (clipped.truncated) lines.push('', '[the output above was truncated for transport]')
  if (markers.length > 0) lines.push('', ...markers)
  return lines.join('\n')
}

/**
 * 按 `createUserMessage()` 的等价结构构造一条 user 消息（不依赖 dsh 核心包）。
 * @param {string} text 正文
 * @param {string} command 命令原文（写入 source，供其它插件识别）
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: string, command: string } }}
 */
export function createShellCommandMessage(text, command) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'shell-command', command },
  }
}

/**
 * 把命令整理成适合做会话标题的一行文本（标题服务还会做字节截断与清理）。
 * @param {string} command 命令原文
 * @returns {string}
 */
export function titleFromCommand(command) {
  if (typeof command !== 'string') return ''
  return command.replace(/\s+/gu, ' ').trim()
}

/**
 * 判断当前是否处于「对话刚开始」：
 * 1. 会话还没有任何标题（人工命名或自动生成都算已有）；
 * 2. 会话日志里没有任何对话活动（`user/message` / `turn/start`）。
 *
 * 只看标题不够：自动标题可能尚未生成；只看活动不够：空白会话。
 * 两者同时满足才算开始——这样对话中途执行的 `/cmd` 不会改标题，
 * 而被 fork/续接、已继承历史消息的会话同样视为「非开始」。
 *
 * @param {any} service sessionTitle 服务
 * @param {any} session 会话（需提供 `snapshotEvents()`）
 * @returns {boolean}
 */
export function isConversationStart(service, session) {
  let current
  try {
    current = typeof service?.get === 'function' ? service.get(session) : undefined
  } catch {
    return false
  }
  if (current !== undefined && current !== null) return false
  let events
  try {
    events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
  } catch {
    events = undefined
  }
  if (!Array.isArray(events)) return false
  for (const event of events) {
    const type = event?.type
    if (type === 'user/message' || type === 'turn/start') return false
  }
  return true
}

/**
 * 用命令命名当前会话——**仅当 `/cmd` 是对话的第一个动作时**。
 *
 * 对话中途执行的 `/cmd` 不改标题：此时会话已有标题或已有 `user/message` /
 * `turn/start` 活动，`isConversationStart()` 返回 false。命令本身照常执行并
 * 把结果发给模型。
 *
 * `sessionTitle.rename()` 以 `source: 'user'` 固定标题，之后自动标题不再覆盖；
 * 失败一律静默，不影响命令执行。
 *
 * @param {any} ctx 插件上下文
 * @param {any} agent 接收命令的 Agent（需带 `session`）
 * @param {string} command 命令原文
 * @returns {boolean} 是否成功写入了标题
 */
export function syncSessionTitle(ctx, agent, command) {
  let service
  try {
    service = typeof ctx?.get === 'function' ? ctx.get('sessionTitle') : undefined
  } catch {
    return false
  }
  if (service === undefined || service === null || typeof service.rename !== 'function') return false
  const session = agent?.session
  if (session === undefined || session === null) return false
  const title = titleFromCommand(command)
  if (title.length === 0) return false
  // 已有待处理输入（排队中的 user 消息）说明对话已经开始，不要再改名。
  const inbox = agent?.inbox
  if (inbox !== undefined && inbox !== null) {
    if ((Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) || (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0)) {
      return false
    }
  }
  if (!isConversationStart(service, session)) return false
  try {
    service.rename(session, title)
    return true
  } catch {
    // 标题失败（例如超出字节上限被拒绝）不影响命令本身。
    return false
  }
}

/**
 * 解析 `/cmd` 调用要使用的 shell 沙箱策略。
 *
 * 关键事实：`ctx.shell`（bash-sandbox executor）在 `resolve()` 里会把**缺省的**
 * `sandboxPolicy` 补成部署级默认策略（`ctx.sandboxPolicy.resolve()`，没有 session），
 * 于是 `/cmd` 会跑在部署默认的 workspace root / 模式里，出现 `git pull` 写
 * `.git/FETCH_HEAD` 报 `Operation not permitted` 这类与终端不一致的行为。
 *
 * `/cmd` 是**人类显式输入**的命令，语义上等价于用户自己开终端执行，所以默认显式传入
 * `danger-full-access` 策略（executor 直接走不套沙箱的本地执行路径）。
 * `useSessionPolicy: true` 时改为采用该会话的策略（workspace-write / read-only），
 * 让 `/cmd` 与模型的 bash 工具保持同一边界。
 *
 * @param {any} ctx 插件上下文
 * @param {any} agent 接收命令的 Agent
 * @param {string} workdir 已解析的工作目录（绝对路径）
 * @param {{ useSessionPolicy?: boolean }} [options]
 * @returns {{ mode: string, workspaceRoot: string, sessionId?: string }}
 */
export function resolveShellSandboxPolicy(ctx, agent, workdir, options = {}) {
  const session = agent?.session
  const sessionCwd = session?.header?.cwd
  const workspaceRoot =
    typeof sessionCwd === 'string' && sessionCwd.length > 0
      ? sessionCwd
      : typeof workdir === 'string' && workdir.length > 0
        ? workdir
        : process.cwd()
  const sessionId = session?.id ?? agent?.id
  if (options.useSessionPolicy === true) {
    let service
    try {
      service = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
    } catch {
      service = undefined
    }
    if (service !== undefined && service !== null && typeof service.resolve === 'function' && session !== undefined) {
      try {
        const resolved = service.resolve({ session })
        if (resolved !== undefined && resolved !== null && typeof resolved.mode === 'string') return resolved
      } catch {
        /* 解析失败时退回不受限执行，保证人类命令可用。 */
      }
    }
  }
  return {
    mode: 'danger-full-access',
    workspaceRoot,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** 读取可选服务（缺失返回 undefined，不抛错）。 */
function optionalService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 交互终端模式是否可用：需要 `webServer`（注册 RPC 路由）、`connection`（认证栅栏）
 * 与 `agents`（按 sessionId 找 Agent）。三者缺一时裸 `/cmd` 仍返回用法错误。
 * @param {any} ctx Host 插件上下文
 * @returns {boolean}
 */
export function isTerminalModeAvailable(ctx) {
  const connection = optionalService(ctx, 'connection')
  const fetchRoutes = connection === undefined || connection === null ? undefined : connection.fetch
  return (
    optionalService(ctx, 'agents') !== undefined &&
    fetchRoutes !== undefined &&
    fetchRoutes !== null &&
    typeof fetchRoutes.register === 'function'
  )
}

/**
 * 执行一条命令并返回结果。
 * @param {any} ctx 插件上下文
 * @param {any} agent 接收该命令的 Agent
 * @param {string} command 命令原文
 * @param {AbortSignal} [signal] 调用方取消信号
 * @param {number} [timeoutMs] 超时
 * @param {{ useSessionPolicy?: boolean, env?: Record<string, string> }} [options] 沙箱策略 / 额外环境变量
 * @returns {Promise<{ result: object, cwd: string }>}
 */
export async function runShell(ctx, agent, command, signal, timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
  const workdir = await ctx.workingDirectory.ensure(agent, signal)
  const spec = ctx.shell.resolve({
    command,
    workdir,
    timeoutMs,
    stdoutMaxBytes: STDOUT_MAX_BYTES,
    onExpiry: 'kill',
    sandboxPolicy: resolveShellSandboxPolicy(ctx, agent, workdir, options),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(signal === undefined ? {} : { signal }),
  })
  const execution = await ctx.shell.execute(spec)
  return { result: await execution.result(), cwd: spec.workdir }
}

/**
 * `/cmd` 的处理逻辑（与注册分离，便于测试）。
 *
 * - `/cmd <命令>`：执行并把命令与输出发给模型（原行为）。
 * - 裸 `/cmd`：返回 `OPEN_MARKER`，浏览器半端据此在输入框上方打开交互终端；
 *   终端内的命令与 Ctrl+Enter 发送由 `/cmd-terminal/rpc` 处理。
 *
 * @param {any} ctx 插件上下文
 * @param {{ agent: any, rawInput: string, signal: AbortSignal }} invocation 命令调用
 * @param {{ timeoutMs?: number, maxOutputChars?: number, nameSession?: boolean, useSessionPolicy?: boolean, createMessage?: (text: string, command: string) => any }} [options]
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
 */
export async function executeShellCommand(ctx, invocation, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputChars =
    Number.isFinite(options.maxOutputChars) && options.maxOutputChars > 0
      ? options.maxOutputChars
      : DEFAULT_MAX_OUTPUT_CHARS
  const createMessage =
    typeof options.createMessage === 'function' ? options.createMessage : createShellCommandMessage
  const command = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  if (command.length === 0) {
    // 裸 `/cmd`：打开交互终端（需要已注册的终端传输）。
    const terminalReady =
      typeof options.isTerminalReady === 'function' ? options.isTerminalReady() === true : isTerminalModeAvailable(ctx)
    if (!terminalReady) return { kind: 'error', text: USAGE }
    // 浏览器半端有两种触发方式：commandview 看到标记（快路径）与轮询 status
    // （兜底，避免命令行卡片未渲染时打不开）。两种方式都消费同一个打开请求。
    try {
      options.terminalRegistry?.requestOpen?.(invocation.agent?.session?.id ?? invocation.agent?.id)
    } catch {
      /* 记录打开请求失败不影响命令结果 */
    }
    return { kind: 'success', text: OPEN_MARKER }
  }

  // 用命令命名会话（在开始执行前就生效，侧边栏立即可见）。
  if (options.nameSession !== false) syncSessionTitle(ctx, invocation.agent, command)

  const shellOptions = { useSessionPolicy: options.useSessionPolicy === true }
  let run
  try {
    run = await runShell(ctx, invocation.agent, command, invocation.signal, timeoutMs, shellOptions)
  } catch (error) {
    if (invocation.signal?.aborted) return { kind: 'error', text: 'Command cancelled.' }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Failed to run command: ${message}` }
  }

  const { text, timedOut, aborted } = composeCommandText(run.result, maxOutputChars)
  if (aborted || invocation.signal?.aborted) {
    // 被取消的命令不进入模型轮次：输出留给卡片，但明确标记为未发送。
    return { kind: 'error', text: `${text}\n[command cancelled; its output was not sent to the model]` }
  }
  const modelText = composeModelText({ command, cwd: run.cwd, result: run.result, maxOutputChars })
  try {
    invocation.agent.followup(createMessage(modelText, command))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: 'error',
      text: `${text}\n[the command ran, but its output could not be sent to the model: ${message}]`,
    }
  }

  return { kind: timedOut ? 'error' : 'success', text }
}

/**
 * 注册 `/cmd` 与交互终端 RPC。
 * @param {any} ctx 插件上下文
 * @param {any} [config] 行配置（可选 timeoutMs / maxOutputChars / nameSession / useSessionPolicy）
 */
export function apply(ctx, config = {}) {
  const options = {
    ...(Number.isFinite(config?.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
    ...(Number.isFinite(config?.maxOutputChars) ? { maxOutputChars: config.maxOutputChars } : {}),
    ...(config?.nameSession === false ? { nameSession: false } : {}),
    ...(config?.useSessionPolicy === true ? { useSessionPolicy: true } : {}),
  }

  // 交互终端：状态与 RPC（浏览器半端通过 POST /cmd-terminal/rpc 驱动）。
  const registry = createTerminalRegistry(ctx, {
    runShell,
    syncSessionTitle,
    createShellCommandMessage,
    clipText,
  })
  options.terminalRegistry = registry
  ctx.effect(() => () => registry.dispose(), 'dsh-shell-cmd: terminal registry')

  const webServer = optionalService(ctx, 'webServer')
  const connection = optionalService(ctx, 'connection')

  // 首选传输：`connection.fetch` 的 `/api` 精确路由（参考 dsh-context）。
  // 必须通过 `ctx.inject(['connection'])` 获取：connection 可能在 web-app 的
  // realm/子上下文里，直接 `ctx.get('connection')` 拿不到时路由就不会注册，
  // 浏览器端表现为 404。
  let terminalRouteReady = false
  ctx.inject(['connection'], (child) => {
    const service = typeof child.get === 'function' ? child.get('connection') : undefined
    const fetchRoutes = service === undefined || service === null ? undefined : service.fetch
    if (fetchRoutes === undefined || fetchRoutes === null || typeof fetchRoutes.register !== 'function') return
    const route = createTerminalFetchRoute(registry)
    child.effect(
      () =>
        fetchRoutes.register({
          path: TERMINAL_FETCH_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: route,
        }),
      'dsh-shell-cmd: terminal /api fetch route',
    )
    terminalRouteReady = true
    child.effect(() => () => {
      terminalRouteReady = false
    }, 'dsh-shell-cmd: terminal route readiness')
  })
  options.isTerminalReady = () => terminalRouteReady
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    const handler = createTerminalRpcHandler({
      registry,
      authReject:
        connection !== undefined && connection !== null && typeof connection.requestRejection === 'function'
          ? (req) => connection.requestRejection({ headers: req.headers })
          : undefined,
      logger: ctx.logger,
    })
    ctx.effect(
      () => webServer.register({ kind: 'exact', path: TERMINAL_ROUTE, handler }),
      'dsh-shell-cmd: terminal rpc route',
    )
  }

  ctx.commands.register({
    name: 'cmd',
    description: 'Run a shell command, or open an interactive terminal with Ctrl+Enter handoff',
    input: { hint: ' <shell command>（留空打开交互终端）' },
    handler: (invocation) => executeShellCommand(ctx, invocation, options),
  })
}
