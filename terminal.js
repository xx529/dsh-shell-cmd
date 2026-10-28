/**
 * dsh-shell-cmd · 交互式命令终端（Host 半端逻辑）
 *
 * 由裸 `/cmd`（无参数）触发：浏览器半端打开终端面板，通过共享 `/api` 桥上的
 * 精确路由 `POST /api/cmd-terminal/rpc`（`createTerminalFetchRoute`）与这里交互。
 * 终端是一个**按行执行的 REPL**：
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

/** 共享 `/api` 桥上的精确路由路径（客户端用相对 `api/cmd-terminal/rpc`）。 */
export const TERMINAL_FETCH_PATH = '/api/cmd-terminal/rpc'

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
  /** 已请求打开、但浏览器半端尚未消费的会话（裸 /cmd 的宿主端信号；status 只 peek）。 */
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

    /**
     * 浏览器半端轮询 / 检查：**只读 peek**，不消费打开请求。
     *
     * 消费留给 `open()`：轮询可能重试（客户端 fetch 失败、面板渲染被卸载等），
     * 若在 status 里取走请求，一次失败的 open 就会让终端永远打不开。
     */
    status(sessionId) {
      return { pendingOpen: pendingOpens.has(sessionId), open: states.has(sessionId) }
    },

    read(sessionId) {
      const state = states.get(sessionId)
      return state === undefined ? undefined : snapshot(state)
    },

    /**
     * 消费打开请求并幂等创建/返回终端状态（重复调用返回同一份状态）。
     *
     * 先消费再建状态：open 失败（例如 session-not-found）也把请求清掉，
     * 避免浏览器半端轮询 status 时无限重试同一次无法完成的打开。
     */
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

    /** 关闭终端：清掉挂起的打开请求与状态，并中止正在运行的命令。 */
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
      pendingOpens.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// 共享 `/api` 桥上的 JSON-RPC
// ---------------------------------------------------------------------------

/** 单次响应的上限（快照本身有界，这里是最后的传输保护）。 */
const MAX_RESPONSE_BYTES = 256 * 1024

/** JSON 响应头（RPC 结果不缓存）。 */
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
})

/** 错误码 → HTTP 状态（未列出的错误码走 500）。 */
const STATUS_BY_CODE = Object.freeze({
  'bad-request': 400,
  'session-not-found': 404,
  busy: 409,
  empty: 409,
})

/** 参数对象化。 */
function paramsOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** 业务错误（RPC 信封要求 details 字段）。 */
function fail(code, message) {
  return { ok: false, error: { code, ...(message === undefined ? {} : { message }), details: {} } }
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
 * 序列化 JSON 响应；超过上限时降级为 500 错误信封（不把巨型响应塞进桥）。
 * @param {any} value 响应体
 * @param {number} status HTTP 状态
 * @returns {Response}
 */
function jsonResponse(value, status) {
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    return new Response(JSON.stringify(fail('internal', 'terminal response too large')), {
      status: 500,
      headers: JSON_HEADERS,
    })
  }
  return new Response(body, { status, headers: JSON_HEADERS })
}

/**
 * 创建挂到 `ctx.connection.fetch` 的精确路由。
 *
 * 浏览器半端用相对地址 `api/cmd-terminal/rpc` 调用；Web 与 Desktop 都由
 * connection 的 `/api` 桥处理（Electron 通过 IPC 桥，页面 origin 不参与），
 * 认证由桥本身完成，因此这里不再重复做鉴权栅栏。
 *
 * @param {any} registry `createTerminalRegistry()` 的返回值
 * @returns {(request: Request) => Promise<Response>}
 */
export function createTerminalFetchRoute(registry) {
  return async function terminalFetchRoute(request) {
    let body = null
    try {
      body = await request.json()
    } catch {
      body = null
    }
    const box = paramsOf(body)
    const method = typeof box.method === 'string' ? box.method : ''
    if (method.length === 0) return jsonResponse(fail('bad-request', 'method is required'), 400)
    const result = await dispatch(registry, method, paramsOf(box.params))
    const status = result.ok === true ? 200 : (STATUS_BY_CODE[result.error?.code] ?? 500)
    return jsonResponse(result, status)
  }
}
