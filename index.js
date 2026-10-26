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

/** 记录每个会话中「本插件写入的标题事件 seq」，用于区分自动标题 / 人工改名。 */
const titledSessions = new WeakMap()

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
 * 用命令名命名当前会话。
 *
 * 规则（避免覆盖用户手动改的名字）：
 * - 尚无标题：写入命令；
 * - 标题来自自动生成（`fallback` / `provider`）：写入命令；
 * - 标题是本插件之前写入的（按 `session/title` 事件 seq 判断）：更新为最新命令；
 * - 标题是用户手动改的（`source.kind === 'user'` 且不是本插件写入）：保持不动。
 *
 * `sessionTitle.rename()` 会以 `source: 'user'` 固定标题，因此之后不会再被自动标题覆盖；
 * 这正是 `/cmd` 作为会话第一动作时的期望。失败一律静默，不影响命令执行。
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
  let current
  try {
    current = typeof service.get === 'function' ? service.get(session) : undefined
  } catch {
    return false
  }
  const ourSeq = titledSessions.get(session)
  if (current !== undefined && current !== null && current.source?.kind === 'user' && current.eventSeq !== ourSeq) {
    // 人工命名过，尊重用户选择。
    return false
  }
  try {
    const snapshot = service.rename(session, title)
    if (snapshot !== undefined && snapshot !== null && Number.isFinite(snapshot.eventSeq)) {
      titledSessions.set(session, snapshot.eventSeq)
    }
    return true
  } catch {
    // 标题失败（例如超出字节上限被拒绝）不影响命令本身。
    return false
  }
}

/**
 * 执行一条命令并返回结果。
 * @param {any} ctx 插件上下文
 * @param {any} agent 接收该命令的 Agent
 * @param {string} command 命令原文
 * @param {AbortSignal} [signal] 调用方取消信号
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<{ result: object, cwd: string }>}
 */
export async function runShell(ctx, agent, command, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const workdir = await ctx.workingDirectory.ensure(agent, signal)
  const spec = ctx.shell.resolve({
    command,
    workdir,
    timeoutMs,
    stdoutMaxBytes: STDOUT_MAX_BYTES,
    onExpiry: 'kill',
    ...(signal === undefined ? {} : { signal }),
  })
  const execution = await ctx.shell.execute(spec)
  return { result: await execution.result(), cwd: spec.workdir }
}

/**
 * `/cmd` 的处理逻辑（与注册分离，便于测试）。
 * @param {any} ctx 插件上下文
 * @param {{ agent: any, rawInput: string, signal: AbortSignal }} invocation 命令调用
 * @param {{ timeoutMs?: number, maxOutputChars?: number, nameSession?: boolean, createMessage?: (text: string, command: string) => any }} [options]
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
  if (command.length === 0) return { kind: 'error', text: USAGE }

  // 用命令命名会话（在开始执行前就生效，侧边栏立即可见）。
  if (options.nameSession !== false) syncSessionTitle(ctx, invocation.agent, command)

  let run
  try {
    run = await runShell(ctx, invocation.agent, command, invocation.signal, timeoutMs)
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
 * 注册 `/cmd`。
 * @param {any} ctx 插件上下文
 * @param {any} [config] 行配置（可选 timeoutMs / maxOutputChars / nameSession）
 */
export function apply(ctx, config = {}) {
  const options = {
    ...(Number.isFinite(config?.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
    ...(Number.isFinite(config?.maxOutputChars) ? { maxOutputChars: config.maxOutputChars } : {}),
    ...(config?.nameSession === false ? { nameSession: false } : {}),
  }
  ctx.commands.register({
    name: 'cmd',
    description: 'Run a shell command, then send the command and its output to the model',
    input: { hint: ' <shell command>' },
    handler: (invocation) => executeShellCommand(ctx, invocation, options),
  })
}
