/**
 * dsh-shell-cmd · 交互式命令终端（Host 半端逻辑）
 *
 * 由裸 `/cmd`（无参数）触发：浏览器半端在输入框上方打开终端面板，通过
 * `POST /cmd-terminal/rpc` 与这里交互。终端是一个**按行执行的 REPL**：
 *
 * - 每条命令都走 `ctx.shell`，因此与 `/cmd <命令>` 一样是 `danger-full-access`
 *   （人类命令等价终端），受同一超时/取消/输出上限保护；
 * - cwd 与简单 `export NAME=VALUE` 在命令之间保留（`cd` 被单独处理）；
 * - 输出按行保存在会话状态里（有界滚动），Ctrl+Enter 时整段转成模型输入。
 *
 * 这里刻意不依赖 `@deepseek-ai/*` 包；所有 dsh 能力通过注入的 ctx 与 deps 使用，
 * 便于 node:test 用伪对象覆盖。
 *
 * @module dsh-shell-cmd/terminal
 */

/** 裸 `/cmd` 的命令结果标记：浏览器半端看到它就把输入与输出转成终端面板。 */
export const OPEN_MARKER = '[[dsh-shell-cmd:terminal]]'

/** 浏览器半端与 Host 之间的固定 RPC 路径。 */
export const TERMINAL_ROUTE = '/cmd-terminal/rpc'

/** 滚动区上限：行数与字符数（超出丢最旧的行）。 */
const MAX_LINES = 1200
const MAX_CHARS = 96 * 1024

/** 模型输入上限（与 /cmd 一致）。 */
const MAX_MODEL_CHARS = 24_000

/** 发送给模型的说明头。 */
const MODEL_HEADER =
  'The user ran these commands in an interactive terminal session inside the DSH composer (/cmd). Respond based on the transcript; these commands were not run by you.'

/** 把任意文本按行写入滚动区。 */
function pushOutput(state, text) {
  if (typeof text !== 'string' || text.length === 0) return
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  for (const line of normalized.split('\n')) state.lines.push(line)
  state.total += normalized.split('\n').length
}

/** 按上限裁剪最旧的行。 */
function trimState(state) {
  let chars = 0
  for (const line of state.lines) chars += line.length + 1
  while (state.lines.length > 0 && (state.lines.length > MAX_LINES || chars > MAX_CHARS)) {
    chars -= (state.lines.shift()?.length ?? 0) + 1
    state.base += 1
  }
}

/** 构造一份可直接返回给浏览器半端的快照。 */
function snapshot(state) {
  trimState(state)
  return {
    lines: state.lines.slice(),
    base: state.base,
    total: state.total,
    cwd: state.cwd,
    busy: state.busy,
    status: state.status,
    sent: state.sent,
    commands: state.commands.slice(),
  }
}

/** 终端状态。 */
function createState(sessionId, cwd) {
  return {
    sessionId,
    cwd,
    vars: {},
    lines: [],
    base: 0,
    total: 0,
    busy: false,
    status: 'idle',
    sent: false,
    controller: null,
    commands: [],
  }
}

/** POSIX 单引号转义。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

/** 解析 `export NAME=VALUE`，返回是否已处理。 */
function handleExport(state, line) {
  const match = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line)
  if (match === null) return false
  let value = match[2].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  state.vars[match[1]] = value
  return true
}

/** 解析 `unset NAME`，返回是否已处理。 */
function handleUnset(state, line) {
  const match = /^unset\s+([A-Za-z_][A-Za-z0-9_]*)$/u.exec(line)
  if (match === null) return false
  delete state.vars[match[1]]
  return true
}

/** 解析单独的 `cd [dir]`，返回目标（空串表示 $HOME）或 null。 */
function parseCd(line) {
  const trimmed = line.trim()
  if (trimmed === 'cd') return ''
  const match = /^cd\s+(.+)$/u.exec(trimmed)
  if (match === null) return null
  let target = match[1].trim()
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1)
  }
  return target
}

/** 把一次命令结果合并成终端正文。 */
function composeTerminalBody(result) {
  let body = typeof result?.stdout?.text === 'string' ? result.stdout.text : ''
  const err = typeof result?.stderr?.text === 'string' ? result.stderr.text : ''
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  return body
}

/** 状态标记（与 /cmd 的语义一致）。 */
function terminalMarkers(result) {
  const markers = []
  if (result?.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  else if (result?.aborted) markers.push('[aborted]')
  else if (result?.signal !== null && result?.signal !== undefined) markers.push(`[killed by signal: ${result.signal}]`)
  else if (result?.exitCode !== 0 && result?.exitCode !== null) markers.push(`[exit code: ${result.exitCode}]`)
  if (result?.stdout?.truncated || result?.stderr?.truncated) markers.push('[some output was truncated by the executor]')
  return markers
}

/** 终端滚动区 → 模型可读的 transcript。 */
export function terminalTranscript(state) {
  return state.lines.join('\n')
}

/**
 * 创建终端注册表。
 *
 * @param {any} ctx Host 插件上下文
 * @param {{
 *   runShell: (ctx: any, agent: any, command: string, signal: any, timeoutMs: any, options: any) => Promise<{ result: any, cwd: string }>,
 *   syncSessionTitle: (ctx: any, agent: any, command: string) => boolean,
 *   createShellCommandMessage: (text: string, command: string) => any,
 *   clipText: (text: string, max: number) => { text: string, truncated: boolean },
 * }} deps
 */
export function createTerminalRegistry(ctx, deps) {
  const { runShell, syncSessionTitle, createShellCommandMessage, clipText } = deps
  /** @type {Map<string, ReturnType<typeof createState>>} */
  const states = new Map()
  /** 已请求打开、但浏览器半端尚未取走的会话（裸 /cmd 的宿主端信号）。 */
  const pendingOpens = new Set()

  /** 按 sessionId 解析仍存活的 Agent。 */
  const resolveAgent = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
    return agents.get(sessionId)
  }

  /** 取得（或创建）一条会话的终端状态。 */
  const ensureState = async (sessionId, signal) => {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    const agent = resolveAgent(sessionId)
    if (agent === undefined) {
      const error = new Error('terminal: session not found')
      error.code = 'session-not-found'
      throw error
    }
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const state = createState(sessionId, cwd)
    states.set(sessionId, state)
    return state
  }

  /** 执行一条终端命令（普通命令 / cd）。 */
  const runLine = async (state, agent, line) => {
    const controller = new AbortController()
    state.controller = controller
    state.busy = true
    state.status = 'running'
    try {
      const run = await runShell(ctx, agent, line, controller.signal, undefined, {
        useSessionPolicy: false,
        env: state.vars,
      })
      return run.result
    } finally {
      state.busy = false
      state.status = 'idle'
      state.controller = null
    }
  }

  return {
    has(sessionId) {
      return states.has(sessionId)
    },

    /** 宿主侧记录一次“打开终端”请求（裸 /cmd 执行时调用）。 */
    requestOpen(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false
      pendingOpens.add(sessionId)
      return true
    },

    /** 浏览器半端轮询：取走一次打开请求，并报告是否已有终端状态。 */
    status(sessionId) {
      const pending = pendingOpens.delete(sessionId)
      return { pendingOpen: pending === true, open: states.has(sessionId) }
    },

    read(sessionId) {
      const state = states.get(sessionId)
      return state === undefined ? undefined : snapshot(state)
    },

    async open(sessionId) {
      pendingOpens.delete(sessionId)
      const state = await ensureState(sessionId)
      return snapshot(state)
    },

    async send(sessionId, rawText) {
      const state = await ensureState(sessionId)
      if (state.busy) {
        const error = new Error('terminal: a command is still running')
        error.code = 'busy'
        throw error
      }
      const line = typeof rawText === 'string' ? rawText.replace(/\r?\n$/u, '') : ''
      if (line.trim().length === 0) return snapshot(state)
      const agent = resolveAgent(sessionId)
      if (agent === undefined) {
        const error = new Error('terminal: session not found')
        error.code = 'session-not-found'
        throw error
      }
      pushOutput(state, `$ ${line}`)
      state.sent = false

      // cd：单独执行并同步 state.cwd。
      const cdTarget = parseCd(line)
      if (cdTarget !== null) {
        try {
          const result = await runLine(state, agent, `cd ${cdTarget === '' ? '"$HOME"' : shellQuote(cdTarget)} && pwd`)
          const stdout = typeof result?.stdout?.text === 'string' ? result.stdout.text.trim() : ''
          const lines = stdout.split('\n').filter((entry) => entry.length > 0)
          const nextCwd = lines.at(-1)
          if ((result?.exitCode ?? 0) === 0 && typeof nextCwd === 'string' && nextCwd.startsWith('/')) {
            state.cwd = nextCwd
          } else {
            pushOutput(state, composeTerminalBody(result) || 'cd failed')
            const markers = terminalMarkers(result)
            if (markers.length > 0) pushOutput(state, markers.join('\n'))
          }
        } catch (error) {
          pushOutput(state, `cd: ${error instanceof Error ? error.message : String(error)}`)
        }
        return snapshot(state)
      }

      // export / unset：只影响后续命令的环境。
      if (handleExport(state, line) || handleUnset(state, line)) return snapshot(state)

      // 普通命令。
      state.commands.push(line)
      try {
        const result = await runLine(state, agent, line)
        pushOutput(state, composeTerminalBody(result))
        const markers = terminalMarkers(result)
        if (markers.length > 0) pushOutput(state, markers.join('\n'))
        return { ...snapshot(state), exitCode: result?.exitCode ?? null }
      } catch (error) {
        pushOutput(state, `error: ${error instanceof Error ? error.message : String(error)}`)
        return snapshot(state)
      }
    },

    cancel(sessionId) {
      const state = states.get(sessionId)
      if (state === undefined || state.controller === null) return false
      state.controller.abort(new Error('cancelled by user'))
      return true
    },

    async finish(sessionId) {
      const state = await ensureState(sessionId)
      if (state.busy) {
        const error = new Error('terminal: wait for the running command to finish or cancel it first')
        error.code = 'busy'
        throw error
      }
      const agent = resolveAgent(sessionId)
      if (agent === undefined) {
        const error = new Error('terminal: session not found')
        error.code = 'session-not-found'
        throw error
      }
      if (state.commands.length === 0) {
        const error = new Error('terminal: run at least one command before sending it to the model')
        error.code = 'empty'
        throw error
      }
      const transcript = clipText(terminalTranscript(state), MAX_MODEL_CHARS)
      const firstCommand = state.commands.find((command) => command.trim().length > 0) ?? 'cmd'
      syncSessionTitle(ctx, agent, firstCommand)
      const modelText = [
        MODEL_HEADER,
        '',
        `cwd: ${state.cwd}`,
        '',
        transcript.text,
        ...(transcript.truncated ? ['', '[the transcript above was truncated for transport]'] : []),
      ].join('\n')
      agent.followup(createShellCommandMessage(modelText, firstCommand))
      state.sent = true
      const result = snapshot(state)
      states.delete(sessionId)
      return { ...result, chars: modelText.length }
    },

    close(sessionId) {
      pendingOpens.delete(sessionId)
      const state = states.get(sessionId)
      if (state === undefined) return false
      if (state.controller !== null) state.controller.abort(new Error('terminal closed'))
      states.delete(sessionId)
      return true
    },

    dispose() {
      for (const state of states.values()) {
        if (state.controller !== null) state.controller.abort(new Error('plugin unloaded'))
      }
      states.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP JSON-RPC
// ---------------------------------------------------------------------------

/** 请求/响应上限。 */
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024

/** 错误码 → HTTP 状态。 */
const STATUS_BY_CODE = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  'bad-request': 400,
  'too-large': 413,
  'session-not-found': 404,
  busy: 409,
  empty: 409,
})

/** 写 JSON 响应（写失败静默：对端断开属常态）。 */
function sendJson(res, status, value, headers = {}) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = JSON.stringify({ ok: false, error: { code: 'internal', message: 'response not serializable' } })
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      'cache-control': 'no-store',
      ...headers,
    })
  } catch {
    // 头已发出
  }
  try {
    res.end(body)
  } catch {
    // 对端断开
  }
}

/** 读取并解析 JSON 请求体。 */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      const error = new Error('request body too large')
      error.code = 'too-large'
      throw error
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) {
    const error = new Error('empty request body')
    error.code = 'bad-request'
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('request body is not valid JSON')
    error.code = 'bad-request'
    throw error
  }
}

/** 参数对象化。 */
function paramsOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 业务错误。 */
function fail(code, message) {
  return { ok: false, error: { code, ...(message === undefined ? {} : { message }) } }
}

/** 业务分派。 */
async function dispatch(registry, method, params) {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  if (sessionId.length === 0) return fail('bad-request', 'sessionId is required')
  try {
    switch (method) {
      case 'open':
        return { ok: true, value: await registry.open(sessionId) }
      case 'read': {
        const value = registry.read(sessionId)
        return { ok: true, value: value === undefined ? null : value }
      }
      case 'status':
        return { ok: true, value: registry.status(sessionId) }
      case 'send':
        return { ok: true, value: await registry.send(sessionId, typeof params.text === 'string' ? params.text : '') }
      case 'cancel':
        return { ok: true, value: { cancelled: registry.cancel(sessionId) } }
      case 'finish':
        return { ok: true, value: await registry.finish(sessionId) }
      case 'close':
        return { ok: true, value: { closed: registry.close(sessionId) } }
      default:
        return fail('bad-request', `unknown method: ${method}`)
    }
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'internal'
    return fail(code, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 创建 `POST /cmd-terminal/rpc` 的 handler。
 *
 * @param {{ registry: any, authReject?: (req: any) => number | undefined, logger?: any }} options
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createTerminalRpcHandler(options) {
  const registry = options.registry
  const authReject = typeof options.authReject === 'function' ? options.authReject : () => undefined
  const logger = options.logger ?? {}

  return async function terminalRpcHandler(req, res) {
    try {
      let rejection
      try {
        rejection = authReject(req)
      } catch (error) {
        logger?.warn?.('[dsh-shell-cmd] terminal auth check failed:', error?.message ?? error)
        rejection = 403
      }
      if (rejection !== undefined && rejection !== null) {
        sendJson(res, typeof rejection === 'number' ? rejection : 401, fail('unauthorized'))
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, fail('method', 'only POST is supported'), { allow: 'POST' })
        return
      }
      const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        sendJson(res, 415, fail('bad-request', 'content-type must be application/json'))
        return
      }
      let body
      try {
        body = await readJsonBody(req, MAX_REQUEST_BYTES)
      } catch (error) {
        const code = error?.code === 'too-large' ? 'too-large' : 'bad-request'
        sendJson(res, code === 'too-large' ? 413 : 400, fail(code, error?.message))
        return
      }
      const method = body !== null && typeof body === 'object' ? body.method : undefined
      if (typeof method !== 'string' || method.length === 0) {
        sendJson(res, 400, fail('bad-request', 'method is required'))
        return
      }
      let result
      try {
        result = await dispatch(registry, method, paramsOf(body?.params))
      } catch (error) {
        logger?.warn?.(`[dsh-shell-cmd] terminal ${method} failed:`, error?.message ?? error)
        result = fail('internal', 'unexpected host-side failure')
      }
      if (result.ok !== true) {
        const code = typeof result.error?.code === 'string' ? result.error.code : 'internal'
        sendJson(res, STATUS_BY_CODE[code] ?? 500, result)
        return
      }
      const json = JSON.stringify(result)
      if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) {
        sendJson(res, 500, fail('internal', 'terminal response too large'))
        return
      }
      sendJson(res, 200, result)
    } catch (error) {
      logger?.warn?.('[dsh-shell-cmd] terminal rpc crashed:', error?.message ?? error)
      try {
        sendJson(res, 500, fail('internal', 'internal transport failure'))
      } catch {
        // 对端断开
      }
    }
  }
}
