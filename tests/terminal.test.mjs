/**
 * dsh-shell-cmd · 交互终端（Host 半端）单元测试
 *
 * 覆盖 terminal.js 的注册表行为（status peek / open 消费 / read / send /
 * cancel / finish / close）、cd/export 处理、模型消息组装，以及共享 `/api` 桥
 * 精确路由 `createTerminalFetchRoute` 的分派/错误码语义。
 * 全程使用伪 ctx / runShell / Request，不 spawn 真进程、不联网。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  OPEN_MARKER,
  terminalTranscript,
  createTerminalRegistry,
  createTerminalFetchRoute,
  TERMINAL_FETCH_PATH,
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
 *
 * 生命周期记录相关：`agent.session.append` 的**每次尝试**记录到
 * `calls.append`，`failAppendOn` 命中的事件类型会抛错，`session:false`
 * 模拟没有会话（append 不可用）；`calls.order` 记录 append / followup 的
 * 交错顺序，用于断言 `command/run → followup → command/done`。
 */
function makeHarness({
  runResults = [],
  titleThrows = false,
  failAppendOn = null,
  session = true,
  followupThrows = false,
} = {}) {
  const calls = { run: [], followup: [], title: [], ensure: [], append: [], order: [] }
  const queue = [...runResults]
  const agents = new Map()
  const append = (type, data) => {
    calls.append.push({ type, data })
    calls.order.push({ kind: 'append', type })
    if (type === failAppendOn) throw new Error(`append ${type} failed`)
    return { type, seq: calls.append.length - 1, time: Date.now(), data }
  }
  const agent = {
    id: 's-1',
    ...(session ? { session: { id: 's-1', append } } : {}),
    followup: (message) => {
      calls.order.push({ kind: 'followup' })
      calls.followup.push(message)
      if (followupThrows) throw new Error('followup failed')
    },
  }
  agents.set('s-1', agent)

  const ctx = {
    workingDirectory: {
      ensure: async (agentArg, signal) => {
        calls.ensure.push({ agentArg, signal })
        return '/tmp/work'
      },
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

/**
 * 用 `/api` 精确路由发一次 RPC，返回状态码与解析后的 JSON 信封。
 * @param {(request: Request) => Promise<Response>} route
 * @param {any} payload 请求体（对象按 JSON 序列化；字符串原样发出；undefined 发空体）
 */
async function callRoute(route, payload) {
  const body =
    payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload)
  const response = await route(
    new Request('http://host/api/cmd-terminal/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    }),
  )
  let json = null
  try {
    json = await response.json()
  } catch {
    json = null
  }
  return { status: response.status, headers: response.headers, json }
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

describe('terminal 常量', () => {
  it('暴露裸 /cmd 的打开标记与共享 /api 桥上的精确路由路径', () => {
    assert.equal(OPEN_MARKER, '[[dsh-shell-cmd:terminal]]')
    assert.equal(TERMINAL_FETCH_PATH, '/api/cmd-terminal/rpc')
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

  it('status 是只读 peek：重复轮询不会消费打开请求', () => {
    const h = makeHarness()

    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: false })
    assert.equal(h.registry.requestOpen('s-1'), true)
    // 轮询允许重试：连查三次都应报告 pendingOpen，请求留给 open 消费。
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: true, open: false })
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: true, open: false })
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: true, open: false })
  })

  it('requestOpen 拒绝空 sessionId', () => {
    const h = makeHarness()
    assert.equal(h.registry.requestOpen(''), false)
    assert.equal(h.registry.requestOpen(undefined), false)
    assert.deepEqual(h.registry.status(undefined), { pendingOpen: false, open: false })
  })

  it('open 消费挂起的打开请求', async () => {
    const h = makeHarness()
    h.registry.requestOpen('s-1')
    await h.registry.open('s-1')
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: true })
  })

  it('open 失败（session-not-found）同样消费请求，避免轮询无限重试', async () => {
    const h = makeHarness()
    h.registry.requestOpen('missing')

    await assert.rejects(() => h.registry.open('missing'), /session not found/u)
    assert.deepEqual(h.registry.status('missing'), { pendingOpen: false, open: false })
  })

  it('重复 open 幂等：复用同一份状态，不重置滚动区 / cwd / 重新解析工作目录', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.open('s-1')
    await h.registry.send('s-1', 'echo x')
    const before = h.registry.read('s-1')

    const again = await h.registry.open('s-1')

    assert.deepEqual(again.lines, ['$ echo x', 'x'])
    assert.deepEqual(again.commands, ['echo x'])
    assert.deepEqual(again, before)
    // ensureState 只在第一次 open 时解析 cwd
    assert.equal(h.calls.ensure.length, 1)
  })

  it('close 清理挂起请求与状态（没有状态时也清请求）', async () => {
    const h = makeHarness()
    h.registry.requestOpen('s-1')
    await h.registry.open('s-1')
    h.registry.requestOpen('s-1')

    assert.equal(h.registry.close('s-1'), true)
    assert.equal(h.registry.has('s-1'), false)
    assert.equal(h.registry.read('s-1'), undefined)
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: false })

    // 第二次 close：没有状态，返回 false，但同样清掉挂起请求。
    h.registry.requestOpen('s-1')
    assert.equal(h.registry.close('s-1'), false)
    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: false })
  })

  it('close 中止运行中的命令并清理状态（不 followup）', async () => {
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
    const running = h.registry.send('s-1', 'sleep')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const signal = h.calls.run[0].signal
    assert.equal(signal.aborted, false)

    assert.equal(h.registry.close('s-1'), true)
    assert.equal(signal.aborted, true)
    assert.equal(h.registry.has('s-1'), false)

    release()
    await running
    assert.equal(h.calls.followup.length, 0)
  })

  it('dispose 清空状态与挂起的打开请求', async () => {
    const h = makeHarness()
    h.registry.requestOpen('s-1')
    await h.registry.open('s-1')
    h.registry.requestOpen('s-2')

    h.registry.dispose()

    assert.deepEqual(h.registry.status('s-1'), { pendingOpen: false, open: false })
    assert.deepEqual(h.registry.status('s-2'), { pendingOpen: false, open: false })
    assert.equal(h.registry.has('s-1'), false)
  })

  it('close（Esc）只丢弃终端内容：不 followup、不改标题', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'secret output' })] })
    await h.registry.open('s-1')
    await h.registry.send('s-1', 'echo secret')
    assert.equal(h.registry.close('s-1'), true)

    // 只有 finish 才会把 transcript 交给模型；close 不产生任何模型消息。
    assert.equal(h.calls.followup.length, 0)
    assert.equal(h.calls.title.length, 0)
    assert.equal(h.registry.has('s-1'), false)
  })

  it('terminalTranscript 返回完整滚动文本', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.send('s-1', 'echo x')
    const snapshot = h.registry.read('s-1')
    assert.equal(terminalTranscript(snapshot), '$ echo x\nx')
  })
})

// ---------------------------------------------------------------------------
// 发送后的命令卡片记录（log-only 的 command 生命周期事件）
// ---------------------------------------------------------------------------

describe('交互终端发送后的命令卡片记录（command/run + command/done）', () => {
  it('finish 按 run → followup → done 的顺序追加同一 commandId 的事件', async () => {
    const h = makeHarness({
      runResults: [makeRun({ stdout: 'one' }), makeRun({ stdout: 'two' })],
    })
    await h.registry.send('s-1', 'echo one')
    await h.registry.send('s-1', 'echo two')

    const result = await h.registry.finish('s-1')

    assert.deepEqual(
      h.calls.append.map((entry) => entry.type),
      ['command/run', 'command/done'],
    )
    const [run, done] = h.calls.append
    assert.match(run.data.commandId, /^cmd-terminal-/u)
    assert.equal(run.data.commandId, done.data.commandId)
    assert.equal(run.data.name, 'cmd')
    assert.equal(run.data.args, 'echo one')
    assert.deepEqual(run.data.source, { kind: 'user' })
    // done.text 就是已经过 clip 的 transcript（卡片正文）。
    assert.deepEqual(done.data, {
      commandId: run.data.commandId,
      kind: 'success',
      text: '$ echo one\none\n$ echo two\ntwo',
    })
    // command/run 必须早于 followup，command/done 必须晚于 followup。
    assert.deepEqual(
      h.calls.order.map((entry) => (entry.kind === 'append' ? entry.type : entry.kind)),
      ['command/run', 'followup', 'command/done'],
    )
    assert.equal(result.sent, true)
  })

  it('卡片记录不改变模型输入：followup 仍恰好一次，文本里没有 commandId', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.send('s-1', 'echo x')

    await h.registry.finish('s-1')

    assert.equal(h.calls.followup.length, 1)
    const message = h.calls.followup[0]
    const commandId = h.calls.append[0].data.commandId
    assert.equal(message.source.kind, 'shell-command')
    assert.equal(message.source.command, 'echo x')
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text.includes(commandId), false)
    assert.equal(message.content[0].text.includes('command/run'), false)
  })

  it('command/run 追加失败不阻断发送：followup 照常，且不补孤立 done', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })], failAppendOn: 'command/run' })
    await h.registry.send('s-1', 'echo x')

    const result = await h.registry.finish('s-1')

    assert.deepEqual(
      h.calls.append.map((entry) => entry.type),
      ['command/run'],
    )
    assert.equal(h.calls.followup.length, 1)
    assert.equal(result.sent, true)
    assert.equal(h.registry.has('s-1'), false)
  })

  it('command/done 追加失败不影响 finish：仍 followup 并成功返回', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })], failAppendOn: 'command/done' })
    await h.registry.send('s-1', 'echo x')

    const result = await h.registry.finish('s-1')

    assert.deepEqual(
      h.calls.append.map((entry) => entry.type),
      ['command/run', 'command/done'],
    )
    assert.equal(h.calls.followup.length, 1)
    assert.equal(result.sent, true)
    assert.equal(h.registry.has('s-1'), false)
  })

  it('followup 抛错时补一条 kind=error 的 done，错误本身原样抛出', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })], followupThrows: true })
    await h.registry.send('s-1', 'echo x')

    await assert.rejects(() => h.registry.finish('s-1'), /followup failed/u)

    assert.deepEqual(
      h.calls.append.map((entry) => entry.type),
      ['command/run', 'command/done'],
    )
    assert.equal(h.calls.append[1].data.kind, 'error')
    assert.equal(h.calls.append[0].data.commandId, h.calls.append[1].data.commandId)
    // 发送失败不清理会话状态（原有错误语义不变）。
    assert.equal(h.registry.has('s-1'), true)
  })

  it('关闭终端 / Esc（close）绝不追加任何命令事件', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.open('s-1')
    await h.registry.send('s-1', 'echo x')

    assert.equal(h.registry.close('s-1'), true)

    assert.deepEqual(h.calls.append, [])
    assert.equal(h.calls.followup.length, 0)
    assert.equal(h.calls.order.length, 0)
  })

  it('finish 第二次（状态已删）不重复追加，而是返回 empty', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    await h.registry.send('s-1', 'echo x')
    await h.registry.finish('s-1')
    const appended = h.calls.append.length

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
    assert.equal(h.calls.append.length, appended)
  })

  it('会话没有 session.append 时 finish 仍成功（best-effort）', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })], session: false })
    await h.registry.send('s-1', 'echo x')

    const result = await h.registry.finish('s-1')

    assert.deepEqual(h.calls.append, [])
    assert.equal(h.calls.followup.length, 1)
    assert.equal(result.sent, true)
  })
})

// ---------------------------------------------------------------------------
// 共享 `/api` 桥上的精确路由
// ---------------------------------------------------------------------------

describe('createTerminalFetchRoute（/api 精确路由）', () => {
  it('open/send 成功时返回 200、ok 信封与 no-store 头', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    const route = createTerminalFetchRoute(h.registry)

    const opened = await callRoute(route, { method: 'open', params: { sessionId: 's-1' } })
    assert.equal(opened.status, 200)
    assert.equal(opened.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(opened.headers.get('cache-control'), 'no-store')
    assert.equal(opened.json.ok, true)
    assert.equal(opened.json.value.cwd, '/tmp/work')
    assert.deepEqual(opened.json.value.lines, [])

    const sent = await callRoute(route, { method: 'send', params: { sessionId: 's-1', text: 'echo x' } })
    assert.equal(sent.status, 200)
    assert.deepEqual(sent.json.value.lines, ['$ echo x', 'x'])
  })

  it('status 分派是只读 peek：连续查询都返回 pendingOpen，open 之后才清零', async () => {
    const h = makeHarness()
    const route = createTerminalFetchRoute(h.registry)
    h.registry.requestOpen('s-1')

    const first = await callRoute(route, { method: 'status', params: { sessionId: 's-1' } })
    const second = await callRoute(route, { method: 'status', params: { sessionId: 's-1' } })
    assert.deepEqual(first.json.value, { pendingOpen: true, open: false })
    assert.deepEqual(second.json.value, { pendingOpen: true, open: false })

    await callRoute(route, { method: 'open', params: { sessionId: 's-1' } })
    const after = await callRoute(route, { method: 'status', params: { sessionId: 's-1' } })
    assert.deepEqual(after.json.value, { pendingOpen: false, open: true })
  })

  it('read 在无状态时返回 null，close 返回 closed 结果', async () => {
    const h = makeHarness()
    const route = createTerminalFetchRoute(h.registry)

    const read = await callRoute(route, { method: 'read', params: { sessionId: 's-1' } })
    assert.equal(read.status, 200)
    assert.equal(read.json.value, null)

    await callRoute(route, { method: 'open', params: { sessionId: 's-1' } })
    const closed = await callRoute(route, { method: 'close', params: { sessionId: 's-1' } })
    assert.equal(closed.status, 200)
    assert.deepEqual(closed.json.value, { closed: true })
  })

  it('非法 JSON / 缺少 method / 未知方法返回 400 bad-request', async () => {
    const h = makeHarness()
    const route = createTerminalFetchRoute(h.registry)

    for (const payload of [
      '{oops',
      undefined,
      '[]',
      JSON.stringify({ params: { sessionId: 's-1' } }),
      JSON.stringify({ method: 'nope', params: { sessionId: 's-1' } }),
    ]) {
      const result = await callRoute(route, payload)
      assert.equal(result.status, 400)
      assert.equal(result.json.ok, false)
      assert.equal(result.json.error.code, 'bad-request')
    }
  })

  it('缺少 sessionId 返回 400，错误信封带 details 字段', async () => {
    const h = makeHarness()
    const route = createTerminalFetchRoute(h.registry)

    const result = await callRoute(route, { method: 'open', params: {} })
    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'bad-request')
    assert.deepEqual(result.json.error.details, {})
  })

  it('会话不存在映射 404 session-not-found', async () => {
    const h = makeHarness()
    const route = createTerminalFetchRoute(h.registry)

    const missing = await callRoute(route, { method: 'open', params: { sessionId: 'missing' } })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'session-not-found')
    assert.deepEqual(missing.json.error.details, {})
  })

  it('busy / empty 映射 409', async () => {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const h = makeHarness({
      runResults: [() => pending.then(() => makeRun({ stdout: 'done' }))],
    })
    const route = createTerminalFetchRoute(h.registry)
    const running = h.registry.send('s-1', 'sleep')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const busy = await callRoute(route, { method: 'finish', params: { sessionId: 's-1' } })
    assert.equal(busy.status, 409)
    assert.equal(busy.json.error.code, 'busy')
    release()
    await running

    const emptyHarness = makeHarness()
    const emptyRoute = createTerminalFetchRoute(emptyHarness.registry)
    const empty = await callRoute(emptyRoute, { method: 'finish', params: { sessionId: 's-1' } })
    assert.equal(empty.status, 409)
    assert.equal(empty.json.error.code, 'empty')
  })

  it('finish 分派成功返回 sent/chars 并 followup 一次', async () => {
    const h = makeHarness({ runResults: [makeRun({ stdout: 'x' })] })
    const route = createTerminalFetchRoute(h.registry)
    await h.registry.send('s-1', 'echo x')

    const result = await callRoute(route, { method: 'finish', params: { sessionId: 's-1' } })
    assert.equal(result.status, 200)
    assert.equal(result.json.value.sent, true)
    assert.equal(typeof result.json.value.chars, 'number')
    assert.equal(h.calls.followup.length, 1)
  })

  it('响应超过 256 KiB 时降级为 500，而不是把巨型 JSON 塞进桥', async () => {
    const route = createTerminalFetchRoute({
      status: () => ({ pendingOpen: false, open: false, blob: 'x'.repeat(300 * 1024) }),
    })

    const result = await callRoute(route, { method: 'status', params: { sessionId: 's-1' } })
    assert.equal(result.status, 500)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error.code, 'internal')
  })
})
