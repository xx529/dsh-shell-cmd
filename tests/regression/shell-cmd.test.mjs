/**
 * dsh-shell-cmd · 独立回归测试（tester / task-5）
 *
 * 目的：为「裸 /cmd 交互终端」三处修复提供 **与产品代码分离的** 回归护栏。
 *
 * 约束（与 task-5 一致）：
 * - 只新增本文件，不改既有测试（tests/terminal.test.mjs / tests/command.test.mjs）与任何产品代码；
 * - 不 spawn 真进程、不联网：所有 Host 依赖用伪 ctx / 伪 registry / WHATWG Request/Response；
 * - client.js 是浏览器半端脚本（依赖 window.__ModuleLoader__），无法直接 import；
 *   装配契约用 vm 伪 window/import 加载工厂验证（R46），UI 行为仍用「源码锁定」断言。
 *   **源码锁定只证明源码里存在/不存在某段文本，不是行为验证**，
 *   真正的浏览器行为只能由人工复验（见 docs/testing/verification.md 第 7 节）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import {
  OPEN_MARKER,
  TERMINAL_FETCH_PATH,
  createTerminalRegistry,
  createTerminalFetchRoute,
} from '../../terminal.js'
import {
  USAGE,
  USER_CARD_META,
  USER_MESSAGE_MARKER,
  apply,
  composeModelText,
  createShellCommandCardMessage,
  executeShellCommand,
  isTerminalModeAvailable,
} from '../../index.js'

const CLIENT_SOURCE = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
const TERMINAL_SOURCE = readFileSync(new URL('../../terminal.js', import.meta.url), 'utf8')
const INDEX_SOURCE = readFileSync(new URL('../../index.js', import.meta.url), 'utf8')
const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

/**
 * 去掉块注释与整行 `//` 注释，只留下「可能被执行」的源码行。
 * 用途：静态锁定断言要区分「注释里提到旧实现」与「真的又用了旧实现」。
 */
function executableLines(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//gu, '')
  return withoutBlocks.split('\n').filter((line) => !/^\s*\/\//u.test(line))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 造一个「会话 s1 活着」的 Host 注册表夹具（不 spawn、不联网）。 */
function createRegistryFixture(options = {}) {
  const calls = { followup: 0, messages: [], ensure: 0, ran: [], syncTitle: [], append: [], order: [] }
  // 生命周期记录：默认提供 session.append（与真实 Host 一致），可注入失败/缺失。
  const session =
    options.sessionAppend === false
      ? { id: 's1' }
      : {
          id: 's1',
          append(type, data) {
            calls.append.push({ type, data })
            calls.order.push(type === 'command/run' ? 'append:run' : type === 'command/done' ? 'append:done' : `append:${type}`)
            if (type === options.appendFailsFor) throw new Error(`append ${type} failed`)
            return { type, seq: calls.append.length - 1 }
          },
        }
  const agent = {
    id: 'agent-1',
    session,
    followup(message) {
      calls.followup += 1
      calls.messages.push(message)
      calls.order.push('followup')
      if (options.followupThrows === true) throw new Error('followup failed')
    },
  }
  const ctx = {
    get(name) {
      if (name !== 'agents') return undefined
      return { get: (sessionId) => (sessionId === 's1' ? agent : undefined) }
    },
    workingDirectory: {
      async ensure() {
        calls.ensure += 1
        return '/tmp/dsh-shell-cmd-workspace'
      },
    },
  }
  const defaultRunShell = async (_ctx, _agent, command) => {
    calls.ran.push(command)
    return {
      result: {
        exitCode: 0,
        signal: null,
        stdout: { text: 'hi\n', truncated: false },
        stderr: { text: '', truncated: false },
      },
      cwd: '/tmp/dsh-shell-cmd-workspace',
    }
  }
  const deps = {
    runShell: options.runShell ?? defaultRunShell,
    syncSessionTitle: (_ctx, _agent, command) => {
      calls.syncTitle.push(command)
      return true
    },
    createShellCommandCardMessage: (text) => ({
      id: 'msg-1',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    clipText: (text) => ({ text: String(text), truncated: false }),
  }
  const registry = createTerminalRegistry(ctx, deps)
  return { registry, ctx, agent, calls }
}

/** 构造 `createTerminalFetchRoute` 使用的 POST Request。 */
function rpcRequest(body) {
  return new Request('http://localhost/api/cmd-terminal/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** 伪 registry：只实现被 dispatch 用到的业务方法。 */
function stubRouteRegistry(overrides = {}) {
  const defaults = {
    status: () => ({ pendingOpen: false, open: false }),
    read: () => null,
    open: async (sessionId) => ({ lines: [], cwd: '/tmp', sessionId }),
    send: async () => ({ lines: [] }),
    cancel: () => false,
    finish: async () => ({ lines: [] }),
    close: () => false,
  }
  return { ...defaults, ...overrides }
}

/** 构造 apply() 用的伪 Host ctx；webServer 故意放一个「一碰就炸」的陷阱。 */
function createApplyCtx(options = {}) {
  const effects = []
  const commands = []
  const injected = []
  const fetchRegistrations = []
  const hasConnectionOption = Object.prototype.hasOwnProperty.call(options, 'connection')
  const connection = hasConnectionOption
    ? options.connection
    : {
        fetch: {
          register(spec) {
            fetchRegistrations.push(spec)
            return () => {}
          },
        },
      }
  // 模拟 dsh 的 ctx.effect 语义：回调**立即执行**，其返回值（disposer）由框架保存。
  const runEffect = (fn) => {
    const disposer = fn()
    effects.push(disposer)
    return disposer
  }
  const ctx = {
    effect(fn) {
      return runEffect(fn)
    },
    inject(deps, fn) {
      injected.push(deps)
      const child = {
        get(name) {
          return name === 'connection' ? connection : undefined
        },
        effect(fn2) {
          return runEffect(fn2)
        },
      }
      fn(child)
    },
    get(name) {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'webServer') {
        return {
          register() {
            throw new Error('apply() must not depend on webServer anymore')
          },
        }
      }
      return undefined
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, effects, commands, injected, fetchRegistrations }
}

// ===========================================================================
// 1. Host 终端注册表生命周期（status peek / open 消费 / close 清理）
// ===========================================================================

describe('terminal.js · registry 生命周期（tester 独立回归）', () => {
  it('R1 status 是只读 peek：不消费 pendingOpen，可重复读取', async () => {
    const { registry } = createRegistryFixture()
    assert.equal(registry.requestOpen('s1'), true)

    const first = registry.status('s1')
    const second = registry.status('s1')
    assert.deepEqual(first, { pendingOpen: true, open: false })
    assert.deepEqual(second, { pendingOpen: true, open: false })
  })

  it('R2 open 消费 pendingOpen，并报告终端状态已建立', async () => {
    const { registry } = createRegistryFixture()
    registry.requestOpen('s1')

    const snapshot = await registry.open('s1')
    assert.equal(typeof snapshot, 'object')
    assert.equal(Array.isArray(snapshot.lines), true)
    assert.equal(snapshot.cwd, '/tmp/dsh-shell-cmd-workspace')

    assert.deepEqual(registry.status('s1'), { pendingOpen: false, open: true })
  })

  it('R3 重复 open 幂等：不重复 ensure、不抛错、返回同一会话状态', async () => {
    const { registry, calls } = createRegistryFixture()
    const first = await registry.open('s1')
    const second = await registry.open('s1')

    assert.equal(calls.ensure, 1, 'ensureState 只应创建一次状态')
    assert.equal(registry.has('s1'), true)
    assert.deepEqual(first.lines, second.lines)
    assert.equal(first.cwd, second.cwd)
  })

  it('R4 close 清理状态：has=false，后续 status 不再 open', async () => {
    const { registry } = createRegistryFixture()
    await registry.open('s1')
    assert.equal(registry.has('s1'), true)

    assert.equal(registry.close('s1'), true)
    assert.equal(registry.has('s1'), false)
    assert.deepEqual(registry.status('s1'), { pendingOpen: false, open: false })
  })

  it('R5 无状态时 close 幂等：返回 false，不抛错', () => {
    const { registry } = createRegistryFixture()
    assert.equal(registry.close('s1'), false)
  })

  it('R6 close 清掉尚未消费的 pendingOpen', () => {
    const { registry } = createRegistryFixture()
    registry.requestOpen('s1')
    assert.equal(registry.status('s1').pendingOpen, true)

    assert.equal(registry.close('s1'), false)
    assert.equal(registry.status('s1').pendingOpen, false)
  })

  it('R7 close 绝不 followup（Esc 语义不变量）', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')
    registry.close('s1')

    assert.equal(calls.followup, 0, 'close 不允许触发 agent.followup')
    assert.equal(registry.has('s1'), false)
  })
})

// ===========================================================================
// 2. finish 才 followup / busy / empty（语义边界）
// ===========================================================================

describe('terminal.js · finish 与 close 的语义边界', () => {
  it('R8 finish 是唯一 followup 路径：内容含命令与 cwd，成功后删除状态', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')
    await registry.send('s1', 'echo hi')

    const result = await registry.finish('s1')
    assert.equal(calls.followup, 1)
    assert.equal(calls.messages.length, 1)
    const text = calls.messages[0].content[0].text
    assert.match(text, /echo hi/u)
    assert.match(text, /cwd: \/tmp\/dsh-shell-cmd-workspace/u)
    assert.equal(typeof result.chars, 'number')
    assert.equal(registry.has('s1'), false, 'finish 成功后 Host 应删除会话状态')
  })

  it('R9 命令运行中 finish 被拒绝（busy），且不 followup', async () => {
    const gate = deferred()
    const { registry, calls } = createRegistryFixture({ runShell: () => gate.promise })
    await registry.open('s1')

    const sending = registry.send('s1', 'slow-command')
    await new Promise((resolve) => setImmediate(resolve))

    await assert.rejects(
      () => registry.finish('s1'),
      (error) => error.code === 'busy',
    )
    assert.equal(calls.followup, 0)

    gate.resolve({
      result: { exitCode: 0, signal: null, stdout: { text: 'done\n', truncated: false }, stderr: { text: '', truncated: false } },
      cwd: '/tmp/dsh-shell-cmd-workspace',
    })
    await sending
    registry.close('s1')
  })

  it('R10 未执行任何命令时 finish 被拒绝（empty），且不 followup', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')

    await assert.rejects(
      () => registry.finish('s1'),
      (error) => error.code === 'empty',
    )
    assert.equal(calls.followup, 0)
  })
})

// ===========================================================================
// 2b. 运行中命令的并发/关闭边界
// ===========================================================================

describe('terminal.js · 运行中命令的边界（不变量）', () => {
  it('R34 close 中止运行中的命令（abort 传给 runShell 的 signal）', async () => {
    const gate = deferred()
    let capturedSignal = null
    const { registry } = createRegistryFixture({
      runShell: (_ctx, _agent, _command, signal) => {
        capturedSignal = signal
        return gate.promise
      },
    })
    await registry.open('s1')

    const sending = registry.send('s1', 'long-running')
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(capturedSignal !== null, 'runShell 必须收到 AbortSignal')

    assert.equal(registry.close('s1'), true)
    assert.equal(capturedSignal.aborted, true, 'close 应 abort 运行中的命令')
    assert.equal(registry.has('s1'), false)

    gate.resolve({ result: { exitCode: 0, signal: null, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }, cwd: '/tmp' })
    await sending
  })

  it('R35 运行中重复 send 被拒绝（busy），不会并发执行', async () => {
    const gate = deferred()
    let runCount = 0
    const { registry } = createRegistryFixture({
      runShell: () => {
        runCount += 1
        return gate.promise
      },
    })
    await registry.open('s1')

    const sending = registry.send('s1', 'slow')
    await new Promise((resolve) => setImmediate(resolve))

    await assert.rejects(
      () => registry.send('s1', 'second'),
      (error) => error.code === 'busy',
    )
    assert.equal(runCount, 1, '第二条命令不应并发执行')

    gate.resolve({ result: { exitCode: 0, signal: null, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }, cwd: '/tmp' })
    await sending
    registry.close('s1')
  })
})

// ===========================================================================
// 2c. finish 的命令生命周期记录（对话里保留终端卡片）
// ===========================================================================

describe('terminal.js · finish 发送带标记的 user 消息（气泡卡片）', () => {
  it('R36 只 followup 一条 user 消息，不再追加 command/run + command/done', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')
    await registry.send('s1', 'echo one')
    await registry.send('s1', 'echo two')

    const result = await registry.finish('s1')

    assert.deepEqual(calls.append, [])
    assert.deepEqual(calls.order, ['followup'])
    assert.equal(calls.followup, 1)
    const message = calls.messages[0]
    assert.deepEqual(message.source, { kind: 'user' })
    assert.equal(message.content[0].type, 'text')
    const text = message.content[0].text
    assert.equal(text.startsWith(`${USER_MESSAGE_MARKER}\n`), true)
    const metaIndex = text.lastIndexOf(`\n${USER_CARD_META}`)
    assert.equal(metaIndex > 0, true)
    const meta = JSON.parse(text.slice(metaIndex + 1 + USER_CARD_META.length))
    assert.equal(meta.command, 'echo one')
    assert.equal(meta.truncated, false)
    assert.equal(text.slice(meta.bodyStart, metaIndex), '$ echo one\nhi\n$ echo two\nhi')
    assert.equal(result.sent, true)
    assert.equal(registry.has('s1'), false, 'finish 成功后仍应删除 Host 会话状态')
  })

  it('R37 模型文本仍带说明头/cwd/transcript，且不含事件名或卡片元数据以外的内容', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.send('s1', 'echo x')
    await registry.finish('s1')

    const text = calls.messages[0].content[0].text
    assert.match(text, /interactive terminal session inside the DSH composer/u)
    assert.match(text, /cwd: \/tmp\/dsh-shell-cmd-workspace/u)
    assert.match(text, /\$ echo x/u)
    assert.equal(text.includes('command/run'), false)
    assert.equal(text.includes('command/done'), false)
    // 元数据行是唯一 JSON，不应重复出现
    assert.equal(text.split(USER_CARD_META).length, 2)
  })

  it('R38 followup 抛错：补一对 run + done(error) 兜底卡片，错误原样抛出，状态保留', async () => {
    const { registry, calls } = createRegistryFixture({ followupThrows: true })
    await registry.send('s1', 'echo x')

    await assert.rejects(() => registry.finish('s1'), /followup failed/u)

    assert.deepEqual(
      calls.append.map((entry) => entry.type),
      ['command/run', 'command/done'],
    )
    const [run, done] = calls.append
    assert.match(run.data.commandId, /^cmd-terminal-[0-9a-f-]{36}$/u)
    assert.equal(run.data.commandId, done.data.commandId)
    assert.equal(run.data.args, 'echo x')
    assert.equal(done.data.kind, 'error')
    assert.match(String(done.data.text), /followup failed/u)
    assert.equal(registry.has('s1'), true, '发送失败时不清理终端状态（原有语义）')
  })

  it('R39 兜底事件 append 失败也只吞掉：错误原样抛出，不留下孤立事件', async () => {
    const { registry, calls } = createRegistryFixture({ followupThrows: true, appendFailsFor: 'command/run' })
    await registry.send('s1', 'echo x')

    await assert.rejects(() => registry.finish('s1'), /followup failed/u)
    assert.deepEqual(calls.append.map((entry) => entry.type), ['command/run'])
    assert.equal(registry.has('s1'), true)
  })

  it('R40 close（Esc/点遮罩）绝不追加事件，也不 followup', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')
    await registry.send('s1', 'echo x')

    assert.equal(registry.close('s1'), true)
    assert.deepEqual(calls.append, [])
    assert.equal(calls.followup, 0)
    assert.deepEqual(calls.order, [])
  })

  it('R41 第二次 finish 不重复发送：返回 empty，followup/append 数量不变', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.send('s1', 'echo x')
    await registry.finish('s1')

    await assert.rejects(
      () => registry.finish('s1'),
      (error) => error.code === 'empty',
    )
    assert.equal(calls.followup, 1)
    assert.deepEqual(calls.append, [])
  })

  it('R42 会话没有 session.append：finish 仍成功', async () => {
    const { registry, calls } = createRegistryFixture({ sessionAppend: false })
    await registry.send('s1', 'echo x')

    const result = await registry.finish('s1')

    assert.deepEqual(calls.append, [])
    assert.equal(calls.followup, 1)
    assert.equal(result.sent, true)
    assert.equal(registry.has('s1'), false)
  })
})

describe('Host 源码锁定 · 卡片记录契约（非行为验证）', () => {
  it('R44 terminal.js finish 用标记 user 消息；成功路径不再追加卡片事件', () => {
    // 源码锁定（非行为验证）：行为由 R36-R42 的伪 agent 覆盖。
    // 1) 标记常量由 terminal.js 统一持有（/cmd 与交互终端共用）。
    assert.match(TERMINAL_SOURCE, /export const USER_MESSAGE_MARKER = '\[\[dsh-shell-cmd:message\]\]'/u)
    assert.match(TERMINAL_SOURCE, /export const USER_CARD_META = '\[\[dsh-shell-cmd:card\]\]'/u)
    // 2) finish 用 composeTerminalCardText 组装、用卡片消息工厂 followup。
    assert.match(TERMINAL_SOURCE, /composeTerminalCardText\(\{ cwd: state\.cwd, transcript, firstCommand \}\)/u)
    assert.match(TERMINAL_SOURCE, /agent\.followup\(createShellCommandCardMessage\(modelText\)\)/u)
    // 3) 元数据 bodyStart 指向 transcript 起点。
    assert.match(
      TERMINAL_SOURCE,
      /const meta = \{ command: firstCommand, bodyStart: head\.length, truncated: transcript\.truncated \}/u,
    )
    // 4) 成功路径不再写 success done（旧的 log-only 卡片记录已移除）。
    assert.doesNotMatch(TERMINAL_SOURCE, /kind: 'success'/u)
    // 5) followup 失败兜底仍是一对 log-only 事件（run args=firstCommand → done error）。
    assert.match(TERMINAL_SOURCE, /appendCommandLifecycle\(agent, 'command\/run', \{[\s\S]{0,240}?args: firstCommand/u)
    assert.match(TERMINAL_SOURCE, /if \(recorded\) \{[\s\S]{0,300}?kind: 'error'/u)
    // 6) close 分支没有任何 append（Esc 绝不产生卡片事件）。
    const closeStart = TERMINAL_SOURCE.indexOf('close(sessionId) {')
    assert.ok(closeStart > 0)
    const closeBlock = TERMINAL_SOURCE.slice(closeStart, TERMINAL_SOURCE.indexOf('dispose() {', closeStart))
    assert.equal(closeBlock.includes('append'), false, 'close 分支不得追加命令事件')
  })
})

// ===========================================================================
// 3. createTerminalFetchRoute：成功信封 + 错误信封/状态码
// ===========================================================================

describe('terminal.js · createTerminalFetchRoute（/api 精确路由）', () => {
  it('R11 成功返回 200 与 {ok:true,value}，响应不缓存', async () => {
    const route = createTerminalFetchRoute(
      stubRouteRegistry({ open: async (sessionId) => ({ lines: [], cwd: '/tmp', sessionId }) }),
    )
    const response = await route(rpcRequest({ method: 'open', params: { sessionId: 's1' } }))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const json = await response.json()
    assert.equal(json.ok, true)
    assert.equal(json.value.sessionId, 's1')
    assert.equal(json.value.cwd, '/tmp')
  })

  it('R12 缺 method → 400 bad-request 信封（含 details 字段）', async () => {
    const route = createTerminalFetchRoute(stubRouteRegistry())
    const response = await route(rpcRequest({}))

    assert.equal(response.status, 400)
    const json = await response.json()
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'bad-request')
    assert.deepEqual(json.error.details, {})
  })

  it('R13 缺 sessionId → 400 bad-request', async () => {
    const route = createTerminalFetchRoute(stubRouteRegistry())
    const response = await route(rpcRequest({ method: 'open', params: {} }))

    assert.equal(response.status, 400)
    const json = await response.json()
    assert.equal(json.error.code, 'bad-request')
  })

  it('R14 未知 method → 400 bad-request，且 message 指出 unknown method', async () => {
    const route = createTerminalFetchRoute(stubRouteRegistry())
    const response = await route(rpcRequest({ method: 'nope', params: { sessionId: 's1' } }))

    assert.equal(response.status, 400)
    const json = await response.json()
    assert.equal(json.error.code, 'bad-request')
    assert.match(String(json.error.message), /unknown method/u)
  })

  it('R15 session-not-found → 404 且保留错误码', async () => {
    const route = createTerminalFetchRoute(
      stubRouteRegistry({
        open: async () => {
          const error = new Error('terminal: session not found')
          error.code = 'session-not-found'
          throw error
        },
      }),
    )
    const response = await route(rpcRequest({ method: 'open', params: { sessionId: 'ghost' } }))

    assert.equal(response.status, 404)
    const json = await response.json()
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'session-not-found')
  })

  it('R16 busy → 409；empty → 409', async () => {
    const busyRoute = createTerminalFetchRoute(
      stubRouteRegistry({
        finish: async () => {
          const error = new Error('busy')
          error.code = 'busy'
          throw error
        },
      }),
    )
    const busyResponse = await busyRoute(rpcRequest({ method: 'finish', params: { sessionId: 's1' } }))
    assert.equal(busyResponse.status, 409)
    assert.equal((await busyResponse.json()).error.code, 'busy')

    const emptyRoute = createTerminalFetchRoute(
      stubRouteRegistry({
        finish: async () => {
          const error = new Error('empty')
          error.code = 'empty'
          throw error
        },
      }),
    )
    const emptyResponse = await emptyRoute(rpcRequest({ method: 'finish', params: { sessionId: 's1' } }))
    assert.equal(emptyResponse.status, 409)
    assert.equal((await emptyResponse.json()).error.code, 'empty')
  })

  it('R17 非 JSON body 不崩溃，返回 400 bad-request', async () => {
    const route = createTerminalFetchRoute(stubRouteRegistry())
    const response = await route(rpcRequest('not-json-at-all'))

    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'bad-request')
  })

  it('R18 成功响应不会被错误码映射误判', async () => {
    const route = createTerminalFetchRoute(stubRouteRegistry({ status: () => ({ pendingOpen: true, open: true }) }))
    const response = await route(rpcRequest({ method: 'status', params: { sessionId: 's1' } }))

    assert.equal(response.status, 200)
    const json = await response.json()
    assert.equal(json.ok, true)
    assert.deepEqual(json.value, { pendingOpen: true, open: true })
  })
})

// ===========================================================================
// 4. index.js：apply 只注册 connection.fetch 的 /api 路由（不再依赖 webServer）
// ===========================================================================

describe('index.js · apply 与传输收敛', () => {
  it('R19 apply 不再依赖 webServer：只注册 connection.fetch 的 /api 精确路由', () => {
    const { ctx, fetchRegistrations, injected, commands } = createApplyCtx()

    assert.doesNotThrow(() => apply(ctx))

    assert.equal(fetchRegistrations.length, 1, '应注册且只注册 1 条 connection.fetch 路由')
    const spec = fetchRegistrations[0]
    assert.equal(spec.path, '/api/cmd-terminal/rpc')
    assert.equal(spec.path, TERMINAL_FETCH_PATH)
    assert.deepEqual(spec.methods, ['POST'])
    assert.equal(spec.requestBody, 'buffered')
    assert.equal(typeof spec.fetch, 'function')
    assert.equal(injected.length, 1, 'connection 必须通过 ctx.inject([...]) 获取')
    assert.deepEqual(injected[0], ['connection'])
    assert.equal(commands.length, 1)
    assert.equal(commands[0].name, 'cmd')
  })

  it('R20 isTerminalModeAvailable 收敛为 agents + connection.fetch.register', () => {
    const withBoth = {
      get(name) {
        if (name === 'agents') return { get: () => undefined }
        if (name === 'connection') return { fetch: { register() {} } }
        return undefined
      },
    }
    assert.equal(isTerminalModeAvailable(withBoth), true)

    const noConnection = {
      get(name) {
        return name === 'agents' ? { get: () => undefined } : undefined
      },
    }
    assert.equal(isTerminalModeAvailable(noConnection), false, '没有 connection 时不可用')

    const noAgents = {
      get(name) {
        return name === 'connection' ? { fetch: { register() {} } } : undefined
      },
    }
    assert.equal(isTerminalModeAvailable(noAgents), false, '没有 agents 时不可用')

    const onlyWebServer = {
      get(name) {
        if (name === 'agents') return { get: () => undefined }
        if (name === 'webServer') return { register() {} }
        return undefined
      },
    }
    assert.equal(isTerminalModeAvailable(onlyWebServer), false, 'webServer 不再是可用性条件')
  })

  it('R21 裸 /cmd 在终端就绪时返回 OPEN_MARKER 并记录打开请求', async () => {
    const opened = []
    const result = await executeShellCommand(
      {},
      { agent: { session: { id: 's1' } }, rawInput: '', signal: undefined },
      {
        isTerminalReady: () => true,
        terminalRegistry: {
          requestOpen(sessionId) {
            opened.push(sessionId)
            return true
          },
        },
      },
    )

    assert.deepEqual(result, { kind: 'success', text: OPEN_MARKER })
    assert.deepEqual(opened, ['s1'])
  })

  it('R22 终端不可用时裸 /cmd 返回 USAGE，且不记录打开请求', async () => {
    const opened = []
    const result = await executeShellCommand(
      {},
      { agent: { session: { id: 's1' } }, rawInput: '', signal: undefined },
      {
        isTerminalReady: () => false,
        terminalRegistry: {
          requestOpen(sessionId) {
            opened.push(sessionId)
            return true
          },
        },
      },
    )

    assert.deepEqual(result, { kind: 'error', text: USAGE })
    assert.deepEqual(opened, [])
  })

  it('R23 apply 注册的 handler：无 connection 时裸 /cmd 走 USAGE（不会误开终端）', async () => {
    const { ctx, commands } = createApplyCtx({ connection: undefined })
    apply(ctx)

    const handler = commands[0].handler
    assert.equal(typeof handler, 'function')
    const result = await handler({
      agent: { session: { id: 's1' } },
      rawInput: '',
      signal: undefined,
    })
    assert.deepEqual(result, { kind: 'error', text: USAGE })
  })
})

// ===========================================================================
// 5. 源码锁定（静态文本断言）
//
// ⚠️ 下面 R24–R32 全部是「源码锁定（regression lock）」：只断言源码文本里存在/
//    不存在某个实现，用于防止回归到已知 bug；**不构成运行时行为验证**。浏览器
//    真实行为只能人工复验（无 CDP / 无页面控制通道）。
// ===========================================================================

describe('client.js · 源码锁定（非行为验证）', () => {
  it('R24 锁定相对端点，且没有把 RPC 绝对化（Bug-1 回归锁）', () => {
    // 源码锁定：终端 RPC 必须是页面相对地址 api/cmd-terminal/rpc。
    assert.match(CLIENT_SOURCE, /const TERMINAL_RPC = 'api\/cmd-terminal\/rpc'/u)
    assert.match(CLIENT_SOURCE, /fetch\(TERMINAL_RPC, \{/u)

    // 源码锁定：可执行代码里不得再出现绝对化来源（注释里解释历史 bug 除外）。
    for (const line of executableLines(CLIENT_SOURCE)) {
      assert.doesNotMatch(line, /streamBaseUrl/u, `禁止用 streamBaseUrl 拼终端地址: ${line.trim()}`)
      assert.doesNotMatch(line, /__DSH_TRANSPORT__/u, `禁止读 __DSH_TRANSPORT__ 拼终端地址: ${line.trim()}`)
      assert.doesNotMatch(line, /document\.baseURI/u, `禁止用 document.baseURI 绝对化: ${line.trim()}`)
      assert.doesNotMatch(line, /new URL\(/u, `禁止 new URL(...) 绝对化终端端点: ${line.trim()}`)
    }
    assert.doesNotMatch(CLIENT_SOURCE, /function terminalEndpoint/u)
  })

  it('R25 锁定面板注册在 conversation.input.overlay（id=shell-cmd-terminal）', () => {
    // 源码锁定：模态必须注册到 conversation.input.overlay，且 id / inject 形状正确。
    assert.match(CLIENT_SOURCE, /ctx\.slots\.inject\('conversation\.input\.overlay'/u)
    assert.match(CLIENT_SOURCE, /name: 'conversation\.input\.overlay'/u)
    assert.match(CLIENT_SOURCE, /id: 'shell-cmd-terminal'/u)
    assert.match(CLIENT_SOURCE, /inject: \(sessionId\) => \(\{ sessionId \}\)/u)
    for (const line of executableLines(CLIENT_SOURCE)) {
      assert.doesNotMatch(line, /name: 'conversation\.input\.dock'/u, '终端面板不应再注册到 input.dock')
    }
    // 源码锁定：/cmd 提示条仍留在 composer.dock。
    assert.match(CLIENT_SOURCE, /id: 'shell-cmd-hint'/u)
    assert.match(CLIENT_SOURCE, /ctx\.slots\.inject\('conversation\.composer\.dock'/u)
  })

  it('R26 锁定 commandUi.decorate bare action 打开模态（Bug-2 主路径）', () => {
    // 源码锁定：/cmd 的 bare 调用由 commandUi.decorate 的 action 打开。
    assert.match(CLIENT_SOURCE, /ctx\.inject\(\['commandUi'\]/u)
    assert.match(CLIENT_SOURCE, /commandUi\.decorate\(\{/u)
    assert.match(CLIENT_SOURCE, /name: 'cmd'/u)
    assert.match(CLIENT_SOURCE, /kind: 'action'/u)
    assert.match(CLIENT_SOURCE, /run: \(session\) =>/u)
    assert.match(CLIENT_SOURCE, /session\?\.sessionId/u)
  })

  it('R27 锁定不存在 claim 阶段自动打开（Bug-3 根因回归锁）', () => {
    // 源码锁定：不允许任何「claimName / claim 命中 cmd 就 setTerminalOpen」的代码行。
    for (const line of executableLines(CLIENT_SOURCE)) {
      if (line.includes('claimName') && line.includes('setTerminalOpen')) {
        assert.fail(`claim 阶段不应再驱动 setTerminalOpen: ${line.trim()}`)
      }
    }
    assert.doesNotMatch(CLIENT_SOURCE, /if \(claimName === 'cmd'\) setTerminalOpen/u)
  })

  it('R28 锁定 Esc 关闭路径：capture keydown + 清残留 /cmd 草稿', () => {
    // 源码锁定：Esc 捕获监听、composing 忽略、setDraft('') 清理。
    assert.match(CLIENT_SOURCE, /document\.addEventListener\('keydown', onKeyDown, true\)/u)
    assert.match(CLIENT_SOURCE, /event\.key !== 'Escape' \|\| event\.isComposing === true/u)
    assert.match(CLIENT_SOURCE, /inputActions\.setDraft\(''\)/u)
    assert.match(CLIENT_SOURCE, /draftRef\.current\.trim\(\) !== '\/cmd'/u)
  })

  it('R29 锁定遮罩样式：fixed + inset:0 + z-index:200 + backdrop blur + 主题令牌', () => {
    // 源码锁定：遮罩/卡片的 CSS 契约。
    assert.match(CLIENT_SOURCE, /\.dsc-term-backdrop \{/u)
    assert.match(CLIENT_SOURCE, /position: fixed;/u)
    assert.match(CLIENT_SOURCE, /inset: 0;/u)
    assert.match(CLIENT_SOURCE, /z-index: 200;/u)
    assert.match(CLIENT_SOURCE, /backdrop-filter: blur\(3px\);/u)
    assert.match(CLIENT_SOURCE, /-webkit-backdrop-filter: blur\(3px\);/u)
    assert.match(CLIENT_SOURCE, /var\(--dsw-alias-bg-mask-1/u)
    assert.match(CLIENT_SOURCE, /width: min\(860px, 100%\);/u)
    assert.match(CLIENT_SOURCE, /max-height: min\(82vh, 720px\);/u)
    // 源码锁定：点遮罩关闭、卡片内不误关。
    assert.match(CLIENT_SOURCE, /event\.target === event\.currentTarget/u)
    assert.match(CLIENT_SOURCE, /stopPropagation/u)
  })

  it('R30 锁定传输健壮性：same-origin / no-store / timeout / 错误码本地化 / 重试', () => {
    // 源码锁定：fetch 选项与错误映射契约。
    assert.match(CLIENT_SOURCE, /credentials: 'same-origin'/u)
    assert.match(CLIENT_SOURCE, /cache: 'no-store'/u)
    assert.match(CLIENT_SOURCE, /AbortSignal\.timeout/u)
    assert.match(CLIENT_SOURCE, /'session-not-found': 'terminal\.error\.sessionNotFound'/u)
    assert.match(CLIENT_SOURCE, /terminal\.error\.network/u)
    assert.match(CLIENT_SOURCE, /terminal\.retry/u)
    assert.match(CLIENT_SOURCE, /readOnly: busy \|\| sent/u)
  })

  it('R31 package.json：版本 0.3.18 且声明 commandUi 客户端依赖', () => {
    assert.equal(PACKAGE_JSON.version, '0.3.18')
    const inject = PACKAGE_JSON?.dsh?.client?.inject
    assert.equal(Array.isArray(inject), true)
    assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-commands'), '必须声明 @deepseek-ai/dsh-client-ui-commands')
    assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
    assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'))
    assert.ok(PACKAGE_JSON.files.includes('client.js'))
    assert.ok(PACKAGE_JSON.files.includes('terminal.js'))
  })

  it('R48 卡片输出常驻滚动 + 「展开全部」打开大卡片模态（模糊背景 / 可滚动 / Esc）', () => {
    // 1) 卡片状态下就可滚动：不再把长输出切成前 10 行，而是完整渲染进有界滚动区。
    assert.doesNotMatch(CLIENT_SOURCE, /lines\.slice\(0, 10\)/u)
    assert.doesNotMatch(CLIENT_SOURCE, /setExpanded/u)
    assert.match(CLIENT_SOURCE, /\.dsc-body \{[\s\S]*?max-height: 320px;[\s\S]*?overflow: auto;/u)
    assert.match(CLIENT_SOURCE, /\.dsc-body \{[\s\S]*?overscroll-behavior: contain;/u)

    // 2) 「展开全部」是弹出大卡片，而不是行内显隐切换。
    assert.match(CLIENT_SOURCE, /function OutputModal\(props\)/u)
    assert.match(CLIENT_SOURCE, /className: 'dsc-expand-backdrop'/u)
    assert.match(CLIENT_SOURCE, /className: 'dsc-expand-card'/u)
    assert.match(CLIENT_SOURCE, /role: 'dialog'/u)
    assert.match(CLIENT_SOURCE, /'aria-modal': 'true'/u)
    assert.match(CLIENT_SOURCE, /'aria-haspopup': 'dialog'/u)
    // 3) 大卡片：更宽更高、输出区可滚动、背景模糊（主题令牌 + 字面遮罩兜底）。
    assert.match(CLIENT_SOURCE, /\.dsc-expand-card \{[\s\S]*?width: min\(940px, 100%\);[\s\S]*?max-height: min\(86vh, 860px\);/u)
    assert.match(CLIENT_SOURCE, /\.dsc-expand-backdrop \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;[\s\S]*?backdrop-filter: blur\(8px\)/u)
    assert.match(CLIENT_SOURCE, /\.dsc-expand-body \{[\s\S]*?overflow: auto;[\s\S]*?overscroll-behavior: contain;/u)
    // 4) 关闭路径：Esc 捕获监听、点遮罩关闭、焦点回到「展开全部」按钮。
    assert.match(CLIENT_SOURCE, /function OutputModal[\s\S]*?event\.key !== 'Escape' \|\| event\.isComposing === true/u)
    assert.match(CLIENT_SOURCE, /function OutputModal[\s\S]*?event\.target === event\.currentTarget/u)
    assert.match(CLIENT_SOURCE, /expandButtonRef\.current/u)
    // 5) 模态仍 portal 到 document.body（卡片祖先可能成为固定包含块）。
    assert.match(CLIENT_SOURCE, /createPortal\(modal, document\.body\)/u)
  })

})

describe('Host 源码锁定（非行为验证）', () => {
  it('R32 terminal.js：只保留 /api 精确路由，移除 webServer 根路径 handler', () => {
    // 源码锁定：/api 精确路由常量 + 不再导出旧 handler / 根路径。
    assert.equal(TERMINAL_FETCH_PATH, '/api/cmd-terminal/rpc')
    assert.equal(OPEN_MARKER, '[[dsh-shell-cmd:terminal]]')
    assert.doesNotMatch(TERMINAL_SOURCE, /export function createTerminalRpcHandler/u)
    assert.doesNotMatch(TERMINAL_SOURCE, /export const TERMINAL_ROUTE/u)
    assert.doesNotMatch(TERMINAL_SOURCE, /'\/cmd-terminal\/rpc'/u)
    // 源码锁定：status 用 has（peek），不是 delete（消费）。
    assert.match(TERMINAL_SOURCE, /status\(sessionId\) \{\s*return \{ pendingOpen: pendingOpens\.has\(sessionId\), open: states\.has\(sessionId\) \}/u)
    assert.doesNotMatch(TERMINAL_SOURCE, /const pending = pendingOpens\.delete\(sessionId\)/u)
  })

  it('R33 index.js：可执行代码不再引用 webServer / 旧 handler', () => {
    // 源码锁定：apply 只走 connection.fetch 的 /api 精确路由。
    const executable = executableLines(INDEX_SOURCE).join('\n')
    assert.doesNotMatch(executable, /webServer/u)
    assert.doesNotMatch(executable, /createTerminalRpcHandler/u)
    assert.doesNotMatch(executable, /TERMINAL_ROUTE/u)
    assert.match(executable, /ctx\.inject\(\['connection'\]/u)
    assert.match(executable, /path: TERMINAL_FETCH_PATH/u)
  })

  it('R34 锁定模态按会话区域定位（右侧拉出侧栏不遮挡 / 不压暗侧栏）', () => {
    // 源码锁定：会话区域锚点 + 右栏收窄 + fixed 包含块原点换算 + 运行时重排。
    assert.match(CLIENT_SOURCE, /\[data-conversation-content\]/u)
    assert.match(CLIENT_SOURCE, /\[data-sidebar-right-panel\]\[data-sidebar-right-open\]/u)
    assert.match(CLIENT_SOURCE, /\[data-dsh-panel-host\]/u)
    assert.match(CLIENT_SOURCE, /function collectRightPanels\(overlay\)/u)
    assert.match(CLIENT_SOURCE, /function resolveSessionFrame\(overlay, anchor, viewport\)/u)
    assert.match(CLIENT_SOURCE, /function measureFrameOrigin\(overlay\)/u)
    assert.match(CLIENT_SOURCE, /function applySessionFrame\(overlay, origin, anchor\)/u)
    assert.match(CLIENT_SOURCE, /function clearSessionFrame\(overlay\)/u)
    assert.match(CLIENT_SOURCE, /ref: backdropRef/u)
    assert.match(CLIENT_SOURCE, /window\.addEventListener\('resize', onResize\)/u)
    assert.match(CLIENT_SOURCE, /new ResizeObserver\(onResize\)/u)
    assert.match(CLIENT_SOURCE, /document\.addEventListener\('pointermove', schedule, \{ passive: true \}\)/u)
    // CSS 兜底仍在：JS 未生效（找不到锚点）时不至于没有遮罩。
    assert.match(CLIENT_SOURCE, /\.dsc-term-backdrop \{/u)
  })

  it('R45 dsh 0.2.2：composer 成为 fixed 包含块，模态必须 portal 到 document.body', () => {
    // 0.2.2-rc.1 起 docked composer 带 will-change: transform（宿主 README 的
    // fixed-overlay 契约）；模态渲染在插槽里会被夹到输入框范围内。
    assert.match(CLIENT_SOURCE, /require\('react-dom'\)/u)
    assert.match(CLIENT_SOURCE, /ReactDOM\.createPortal\(modal, document\.body\)/u)
    // 插槽里保留隐藏锚点，portal 后仍能定位会话正文。
    assert.match(CLIENT_SOURCE, /ref: anchorHostRef/u)
    assert.match(CLIENT_SOURCE, /host\.closest\(SESSION_ANCHOR_SELECTOR\)/u)
    // 引擎范围必须正式声明 0.2.2 预发布线（plain semver 不自动包含 rc）。
    assert.match(PACKAGE_JSON.engines.dsh, />=0\.2\.2-rc\.1/u)
  })
})


describe('Client bundle 装配（vm 加载，不做真实渲染）', () => {
  const makeReact = () => {
    const noop = () => {}
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: Symbol.for('react.fragment'),
      useRef: (current) => ({ current }),
      useState: (init) => [typeof init === 'function' ? init() : init, noop],
      useEffect: noop,
      useLayoutEffect: noop,
      useCallback: (fn) => fn,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
  }

  /**
   * 用伪 window 载入 client.js，取回 `__ModuleLoader__` 注册与工厂导出。
   * @param {{ reactDom?: 'stub' | 'missing' }} options react-dom 种子模块可用性
   * @returns {{ registration: any, exports: any }}
   */
  function loadBundle(options = {}) {
    let registration = null
    const window = {
      __ModuleLoader__: {
        load: (value) => {
          registration = value
        },
      },
    }
    const require = (spec) => {
      if (spec === 'react') return makeReact()
      if (spec === 'react-dom') {
        if (options.reactDom === 'missing') throw new Error('react-dom seed module is unavailable')
        return { createPortal: (node, target) => ({ portal: true, node, target }) }
      }
      throw new Error(`unexpected require: ${spec}`)
    }
    // effect 会执行 insertStyle（document 只在 effect 回调里用），给最小 DOM 桩。
    const document = {
      body: { tagName: 'BODY' },
      createElement: () => ({ setAttribute() {}, remove() {} }),
      head: { appendChild() {} },
    }
    vm.runInNewContext(CLIENT_SOURCE, { window, document }, { filename: 'client.js' })
    assert.notEqual(registration, null, 'client.js 必须向 __ModuleLoader__ 注册工厂')
    return { registration, exports: registration.factory(require), document }
  }

  /** 伪 ctx：记录注册；effect 同步执行工厂回调（与 Cordis 一致），返回清理函数。 */
  function makeCtx() {
    const slotSpecs = []
    const slotEntries = []
    const slotInjects = []
    const decorations = []
    const effects = []
    const userTextRules = []
    const effect = (fn, label) => {
      effects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    }
    const ctx = {
      effect,
      locale: {
        register: () => () => {},
        bind: () => (key) => key,
      },
      slots: {
        inject: (name, register) => {
          slotInjects.push(name)
          register()
        },
        register: (spec, component) => {
          slotSpecs.push(spec)
          slotEntries.push({ spec, component })
          return () => {}
        },
      },
      inject: (deps, callback) => {
        callback({
          effect,
          commandUi: {
            decorate: (spec) => {
              decorations.push(spec)
              return () => {}
            },
          },
          uiConversation: {
            userText: {
              register: (rule) => {
                userTextRules.push(rule)
                return () => {}
              },
            },
          },
        })
      },
    }
    return { ctx, slotSpecs, slotEntries, slotInjects, decorations, effects, userTextRules }
  }

  it('R46 工厂导出与三槽装配在 react-dom 可用/缺失时都成立（0.2.2 降级路径）', () => {
    for (const reactDom of ['stub', 'missing']) {
      const { registration, exports } = loadBundle({ reactDom })
      assert.equal(registration.id, 'dsh-shell-cmd')
      assert.equal(registration.chunk, undefined)
      assert.deepEqual([...exports.inject], ['slots', 'locale'])
      assert.equal(typeof exports.apply, 'function')

      const state = makeCtx()
      exports.apply(state.ctx)
      const specs = state.slotSpecs.map((spec) => `${spec.name}:${spec.key ?? spec.id}`)
      assert.ok(specs.includes('conversation.chat.commandview:cmd'))
      assert.ok(specs.includes('conversation.composer.dock:shell-cmd-hint'))
      assert.ok(specs.includes('conversation.input.overlay:shell-cmd-terminal'))
      assert.ok(state.slotInjects.includes('conversation.input.overlay'))
      assert.ok(state.decorations.some((spec) => spec.name === 'cmd' && spec.ui?.kind === 'action'))
      assert.ok(state.effects.includes('dsh-shell-cmd: card styles'))
      assert.ok(state.userTextRules.some((rule) => rule.id === 'shell-cmd-card'))
      assert.ok(specs.includes('conversation.user.text.node:shell-cmd-card'))
    }
  })

  it('R47 打开后的模态渲染为 document.body portal，插槽内只留隐藏锚点', () => {
    const { exports, document } = loadBundle()
    const state = makeCtx()
    exports.apply(state.ctx)
    const entry = state.slotEntries.find((item) => item.spec.name === 'conversation.input.overlay')
    assert.equal(entry.spec.id, 'shell-cmd-terminal')
    // 装饰 action 打开该 Session 的终端（与真实 commandUi 裸调用路径一致）。
    const action = state.decorations.find((spec) => spec.name === 'cmd')
    action.ui.run({ sessionId: 's1' })

    // 直接执行 TerminalEntry / TerminalOverlay（React 钩子用桩，useLayoutEffect 不跑几何）。
    const entryElement = entry.component({
      sessionId: 's1',
      useInput: (selector) => selector({ phase: 'plain', draft: '/cmd' }),
      inputActions: {},
      t: (key) => key,
    })
    const rendered = entryElement.type(entryElement.props)
    assert.equal(rendered.type, Symbol.for('react.fragment'))
    const [anchor, portal] = rendered.children
    assert.equal(anchor.type, 'span')
    assert.equal(anchor.props.hidden, true)
    assert.notEqual(anchor.props.ref, undefined, '插槽内必须保留隐藏锚点（用于会话区域定位）')
    assert.equal(portal.portal, true)
    assert.equal(portal.target, document.body)
    assert.equal(portal.node.props.className, 'dsc-term-backdrop')
  })

  it('R49 /cmd 结果作为 user 消息，在气泡里渲染成终端卡片（UserText 规则）', () => {
    // Host 契约：真实 composeModelText 产出标记 + 元数据，消息工厂用 user source。
    const result = {
      stdout: { text: 'Updating abc..def\nFast-forward\n README.md | 2 +-\n', truncated: false },
      stderr: { text: '', truncated: false },
      exitCode: 0,
      timedOut: false,
      aborted: false,
      signal: null,
      timeoutMs: 1000,
    }
    const text = composeModelText({ command: 'git pull', cwd: '/tmp/work', result })
    assert.equal(text.startsWith(USER_MESSAGE_MARKER), true)
    const metaIndex = text.lastIndexOf(`\n${USER_CARD_META}`)
    assert.equal(metaIndex > 0, true)
    const meta = JSON.parse(text.slice(metaIndex + 1 + USER_CARD_META.length))
    assert.equal(meta.command, 'git pull')
    assert.equal(text.slice(meta.bodyStart).startsWith('Updating abc..def'), true)
    assert.deepEqual(createShellCommandCardMessage(text).source, { kind: 'user' })

    // 客户端行为（vm 真实执行规则）：带标记的消息整段替换为卡片节点。
    const { exports } = loadBundle()
    const state = makeCtx()
    exports.apply(state.ctx)
    assert.equal(state.userTextRules.length, 1)
    const rule = state.userTextRules[0]
    assert.equal(rule.id, 'shell-cmd-card')
    assert.equal(rule.order < 0, true)
    const candidate = rule.match(text, 0)
    assert.notEqual(candidate, undefined)
    assert.deepEqual([candidate.start, candidate.end], [0, text.length])
    assert.equal(candidate.data.command, 'git pull')
    assert.equal(candidate.data.body.includes('Updating abc..def'), true)
    assert.equal(rule.match('普通用户消息，没有标记', 0), undefined)
    assert.equal(rule.match(text, 5), undefined)

    // 槽位装配 + 气泡容器样式。
    assert.equal(
      state.slotSpecs.some((spec) => spec.name === 'conversation.user.text.node' && spec.key === 'shell-cmd-card'),
      true,
    )
    assert.match(CLIENT_SOURCE, /function parseUserCommandText\(raw\)/u)
    assert.match(CLIENT_SOURCE, /function ShellCmdUserCard\(props\)/u)
    assert.match(CLIENT_SOURCE, /data-shell-cmd-message-card/u)
    assert.match(CLIENT_SOURCE, /\[data-message-bubble\]:has\(\[data-shell-cmd-message-card\]\)/u)
    // 气泡父级撑满整行（宿主 userStack 默认是 82% / 0.702 倍内容宽的 fit-content 列）。
    assert.match(CLIENT_SOURCE, /div:has\(> \[data-message-bubble\]:has\(\[data-shell-cmd-message-card\]\)\)/u)
    // 新式 command 节点（recordInput:false → 无 args）不再重复出卡片。
    assert.match(CLIENT_SOURCE, /node\.args === null \|\| node\.args === undefined/u)
  })
})
