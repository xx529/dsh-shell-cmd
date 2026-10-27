/**
 * dsh-shell-cmd · 交互终端（Host 半端）单元测试
 *
 * 覆盖 terminal.js 的注册表行为（open/read/send/cancel/finish/close）、cd/export
 * 处理、模型消息组装，以及 HTTP RPC handler 的传输/鉴权/分派语义。
 * 全程使用伪 ctx / runShell / req / res，不 spawn 真进程、不联网。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  OPEN_MARKER,
  TERMINAL_ROUTE,
  terminalTranscript,
  createTerminalRegistry,
  createTerminalRpcHandler,
} from '../terminal.js'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 构造一次命令结果。 */
function makeRun({ stdout = '', stderr = '', exitCode = 0, ...rest } = {}) {
  return {
    result: {
      exitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120000,
      stdout: { text: stdout, truncated: false },
      stderr: { text: stderr, truncated: false },
      ...rest,
    },
    cwd: '/tmp/work',
  }
}

/**
 * 终端测试夹具：伪 agents / workingDirectory + 可排队的 runShell。
 * runResults 里每一项可以是 makeRun(...)，也可以是返回 Promise 的函数。
 */
function makeHarness({ runResults = [], titleThrows = false } = {}) {
  const calls = { run: [], followup: [], title: [] }
  const queue = [...runResults]
  const agents = new Map()
  const agent = {
    id: 's-1',
    session: { id: 's-1' },
    followup: (message) => calls.followup.push(message),
  }
  agents.set('s-1', agent)

  const ctx = {
    workingDirectory: {
      ensure: async () => '/tmp/work',
    },
    get: (name) => {
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return undefined
    },
  }

  const deps = {
    runShell: async (_ctx, _agent, command, signal, timeoutMs, options) => {
      calls.run.push({ command, signal, timeoutMs, options })
      const next = queue.length > 0 ? queue.shift() : makeRun({ stdout: '' })
      return typeof next === 'function' ? next({ command, signal, options }) : next
    },
    syncSessionTitle: (_ctx, _agent, command) => {
      if (titleThrows) throw new Error('title failed')
      calls.title.push(command)
      return true
    },
    createShellCommandMessage: (text, command) => ({
      id: 'fake-message',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'shell-command', command },
    }),
    clipText: (text, max) =>
      text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true },
  }

  const registry = createTerminalRegistry(ctx, deps)
  return { registry, deps, calls, agent, queue }
}

/** 构造伪 IncomingMessage。 */
function makeReq({ method = 'POST', headers = { 'content-type': 'application/json' }, body = undefined } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

/** 构造伪 ServerResponse。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

/** 调用一次 RPC handler。 */
async function callRpc(handler, { req, ...options } = {}) {
  const res = makeRes()
  await handler(options.req ?? req ?? makeReq(), res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe('terminal 常量', () => {
  it('暴露裸 /cmd 的打开标记与固定 RPC 路径', () => {
    assert.equal(OPEN_MARKER, '[[dsh-shell-cmd:terminal]]')
    assert.equal(TERMINAL_ROUTE, '/cmd-terminal/rpc')
  })
})

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

describe('createTerminalRegistry', () => {
  it('open 解析 Agent 与会话工作目录并返回空终端快照', async () => {
    const h = makeHarness()
    const snapshot = await h.registry.open('s-1')

    assert.deepEqual(snapshot.lines, [])
    assert.equal(snapshot.cwd, '/tmp/work')
    assert.equal(snapshot.busy, false)
    assert.equal(snapshot.status, 'idle')
    assert.equal(h.registry.has('s-1'), true)
  })

  it('未知会话返回 session-not-found', async () => {
    const h = makeHarness()
    await assert.rejects(() => h.registry.open('missing'), /session not found/u)
    await assert.rejects(
      async () => {
        try {
          await h.registry.open('missing')
        } catch (error) {
          assert.equal(error.code, 'session-not-found')
          throw error
        }
      },
      /session not found/u,
    )
  })

  it('send 执行命令并把 $ 命令行与输出写入滚动区', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'a\nb\n' })] })
    const snapshot = await h.registry.send('s-1', 'echo hi')

    assert.equal(h.calls.run.length, 1)
    assert.equal(h.calls.run[0].command, 'echo hi')
    assert.equal(h.calls.run[0].options.useSessionPolicy, false)
    assert.deepEqual(h.calls.run[0].options.env, {})
    assert.deepEqual(snapshot.lines, ['$ echo hi', 'a', 'b'])
    assert.deepEqual(snapshot.commands, ['echo hi'])
    assert.equal(snapshot.exitCode, 0)
  })

  it('非零退出写入 [exit code: N] 标记', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'partial', exitCode: 3 })] })
    const snapshot = await h.registry.send('s-1', 'false-ish')

    assert.deepEqual(snapshot.lines, ['$ false-ish', 'partial', '[exit code: 3]'])
  })

  it('cd 单独执行并把 cwd 更新到新目录', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: '/tmp/other\n' })] })
    const snapshot = await h.registry.send('s-1', 'cd /tmp/other')

    assert.equal(h.calls.run[0].command, "cd '/tmp/other' && pwd")
    assert.equal(snapshot.cwd, '/tmp/other')
    assert.deepEqual(snapshot.lines, ['$ cd /tmp/other'])
    assert.deepEqual(snapshot.commands, [])
  })

  it('cd 失败时保留原 cwd 并写入错误', async () => {
    const h = makeHarness({
      runResults: [makeRun({ stderr: 'no such directory', exitCode: 1 })],
    })
    const snapshot = await h.registry.send('s-1', 'cd /nope')

    assert.equal(snapshot.cwd, '/tmp/work')
    assert.deepEqual(snapshot.lines, ['$ cd /nope', '[stderr]', 'no such directory', '[exit code: 1]'])
  })

  it('export 影响后续命令的 env，且不触发 shell', async () => {
    const h = makeHarness()
    const afterExport = await h.registry.send('s-1', 'export FOO=bar')
    assert.equal(h.calls.run.length, 0)
    assert.deepEqual(afterExport.lines, ['$ export FOO=bar'])

    await h.registry.send('s-1', 'echo $FOO')
    assert.equal(h.calls.run.length, 1)
    assert.deepEqual(h.calls.run[0].options.env, { FOO: 'bar' })
  })

  it('unset 移除导出变量', async () => {
    const h = makeHarness()
    await h.registry.send('s-1', 'export FOO=bar')
    await h.registry.send('s-1', 'unset FOO')
    await h.registry.send('s-1', 'echo $FOO')

    assert.deepEqual(h.calls.run[0].options.env, {})
  })

  it('命令执行中再次 send 返回 busy', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const h = makeHarness({
      runResults: [
        () =>
          pending.then(() => {
            return makeRun({ stdout: 'done' })
          }),
      ],
    })

    const first = h.registry.send('s-1', 'sleep 1')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await assert.rejects(
      async () => {
        try {
          await h.registry.send('s-1', 'echo nope')
        } catch (error) {
          assert.equal(error.code, 'busy')
          throw error
        }
      },
      /still running/u,
    )
    release()
    await first

    assert.equal(h.calls.run.length, 1)
  })

  it('cancel 中止正在运行的命令', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const h = makeHarness({
      runResults: [
        ({ signal }) =>
          pending.then(() => {
            assert.equal(signal.aborted, true)
            return makeRun({ stdout: 'stopped', aborted: true, exitCode: null })
          }),
      ],
    })

    const running = h.registry.send('s-1', 'long')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(h.registry.cancel('s-1'), true)
    release()
    const snapshot = await running

    assert.deepEqual(snapshot.lines, ['$ long', 'stopped', '[aborted]'])
  })

  it('finish 把 transcript 作为模型消息 followup，并按第一条命令命名', async () => {
    const h = makeHarness({
      runResults: [makeRun({ stdout: 'one' }), makeRun({ stdout: 'two' })],
    })
    await h.registry.send('s-1', 'echo one')
    await h.registry.send('s-1', 'echo two')

    const result = await h.registry.finish('s-1')

    assert.equal(h.calls.title.length, 1)
    assert.equal(h.calls.title[0], 'echo one')
    assert.equal(h.calls.followup.length, 1)
    const message = h.calls.followup[0]
    assert.equal(message.source.kind, 'shell-command')
    assert.equal(message.source.command, 'echo one')
    assert.equal(message.content[0].type, 'text')
    const text = message.content[0].text
    assert.equal(text.includes('interactive terminal session'), true)
    assert.equal(text.includes('cwd: /tmp/work'), true)
    assert.equal(text.includes('$ echo one'), true)
    assert.equal(text.includes('$ echo two'), true)
    assert.equal(text.includes('one'), true)
    assert.equal(text.includes('two'), true)
    assert.equal(result.sent, true)
    assert.equal(h.registry.has('s-1'), false)
  })

  it('未执行任何命令时 finish 返回 empty', async () => {
    const h = makeHarness()
    await h.registry.open('s-1')
    await assert.rejects(
      async () => {
        try {
          await h.registry.finish('s-1')
        } catch (error) {
          assert.equal(error.code, 'empty')
          throw error
        }
      },
      /run at least one command/u,
    )
  })

  it('取消后 finish 报 busy 直到运行结束', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const h = makeHarness({
      runResults: [() => pending.then(() => makeRun({ stdout: 'x' }))],
    })
    const running = h.registry.send('s-1', 'sleep')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await assert.rejects(
      async () => {
        try {
          await h.registry.finish('s-1')
        } catch (error) {
          assert.equal(error.code, 'busy')
          throw error
        }
      },
      /wait for the running command/u,
    )
    release()
    await running
  })

  it('requestOpen / status 传递并消费一次打开请求', () => {
    const h = makeHarness()

    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: false })
    assert.equal(h.registry.requestOpen('s-1'), true)
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: true, open: false })
    // 第二次读取已被取走
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: false })
  })

  it('open 会清除挂起的打开请求', async () => {
    const h = makeHarness()
    h.registry.requestOpen('s-1')
    await h.registry.open('s-1')
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: true })
  })

  it('close 移除会话状态', async () => {
    const h = makeHarness()
    await h.registry.open('s-1')
    assert.equal(h.registry.close('s-1'), true)
    assert.equal(h.registry.close('s-1'), false)
    assert.equal(h.registry.has('s-1'), false)
    assert.equal(h.registry.read('s-1'), undefined)
  })

  it('terminalTranscript 返回完整滚动文本', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.send('s-1', 'echo x')
    const snapshot = h.registry.read('s-1')
    assert.equal(terminalTranscript(snapshot), '$ echo x\nx')
  })
})

// ---------------------------------------------------------------------------
// HTTP RPC
// ---------------------------------------------------------------------------

describe('createTerminalRpcHandler', () => {
  const makeHandler = (h) =>
    createTerminalRpcHandler({
      registry: h.registry,
      logger: { warn() {} },
    })

  it('POST open 返回快照', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'open', params: { sessionId: 's-1' } } }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.value.cwd, '/tmp/work')
    assert.deepEqual(result.json.value.lines, [])
  })

  it('未知方法返回 400 bad-request', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'nope', params: { sessionId: 's-1' } } }),
    })

    assert.equal(result.status, 400)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'bad-request')
  })

  it('缺少 sessionId 返回 400', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'open', params: {} } }),
    })

    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'bad-request')
  })

  it('会话不存在时返回 404 session-not-found', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'open', params: { sessionId: 'missing' } } }),
    })

    assert.equal(result.status, 404)
    assert.equal(result.json.error.code, 'session-not-found')
  })

  it('非 POST 返回 405', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ method: 'GET', body: undefined }),
    })

    assert.equal(result.status, 405)
  })

  it('错误 Content-Type 返回 415', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ headers: { 'content-type': 'text/plain' }, body: 'x' }),
    })

    assert.equal(result.status, 415)
  })

  it('非法 JSON 返回 400', async () => {
    const h = makeHarness()
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: '{oops' }),
    })

    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'bad-request')
  })

  it('认证栅栏拒绝时返回 401', async () => {
    const h = makeHarness()
    const handler = createTerminalRpcHandler({
      registry: h.registry,
      authReject: () => 401,
      logger: { warn() {} },
    })
    const result = await callRpc(handler, {
      req: makeReq({ body: { method: 'open', params: { sessionId: 's-1' } } }),
    })

    assert.equal(result.status, 401)
    assert.equal(result.json.error.code, 'unauthorized')
  })

  it('status 分派返回 pendingOpen / open', async () => {
    const h = makeHarness()
    h.registry.requestOpen('s-1')
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'status', params: { sessionId: 's-1' } } }),
    })

    assert.equal(result.status, 200)
    assert.deepEqual(result.json.value, { pendingOpen: true, open: false })
  })

  it('send 分派到注册表并返回新行', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'hi' })] })
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'send', params: { sessionId: 's-1', text: 'echo hi' } } }),
    })

    assert.equal(result.status, 200)
    assert.deepEqual(result.json.value.lines, ['$ echo hi', 'hi'])
  })

  it('finish 分派并返回 chars', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.send('s-1', 'echo x')
    const result = await callRpc(makeHandler(h), {
      req: makeReq({ body: { method: 'finish', params: { sessionId: 's-1' } } }),
    })

    assert.equal(result.status, 200)
    assert.equal(result.json.value.sent, true)
    assert.equal(typeof result.json.value.chars, 'number')
    assert.equal(h.calls.followup.length, 1)
  })
})
