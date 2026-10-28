/**
 * dsh-shell-cmd · 独立回归测试（tester / task-5）
 *
 * 目的：为「裸 /cmd 交互终端」三处修复提供 **与产品代码分离的** 回归护栏。
 *
 * 约束（与 task-5 一致）：
 * - 只新增本文件，不改既有测试（tests/terminal.test.mjs / tests/command.test.mjs）与任何产品代码；
 * - 不 spawn 真进程、不联网：所有 Host 依赖用伪 ctx / 伪 registry / WHATWG Request/Response；
 * - client.js 是浏览器半端脚本（依赖 window.__ModuleLoader__），无法在 node:test 里导入，
 *   因此改用「源码锁定」断言。**源码锁定只证明源码里存在/不存在某段文本，不是行为验证**，
 *   真正的浏览器行为只能由人工复验（见 docs/testing/verification.md 第 7 节）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  OPEN_MARKER,
  TERMINAL_FETCH_PATH,
  createTerminalRegistry,
  createTerminalFetchRoute,
} from '../../terminal.js'
import { USAGE, apply, executeShellCommand, isTerminalModeAvailable } from '../../index.js'

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
    createShellCommandMessage: (text, command) => ({
      id: 'msg-1',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'shell-command', command },
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

describe('terminal.js · finish 追加 command/run + command/done（卡片记录）', () => {
  it('R36 按 run → followup → done 顺序追加、同一 commandId、args=第一条命令、done.text=transcript', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')
    await registry.send('s1', 'echo one')
    await registry.send('s1', 'echo two')

    const result = await registry.finish('s1')

    assert.deepEqual(
      calls.append.map((entry) => entry.type),
      ['command/run', 'command/done'],
    )
    const [run, done] = calls.append
    assert.match(run.data.commandId, /^cmd-terminal-[0-9a-f-]{36}$/u)
    assert.equal(run.data.commandId, done.data.commandId, 'run 与 done 必须共用同一 commandId')
    assert.equal(run.data.name, 'cmd', "name 必须是 'cmd'（commandview 的 key）")
    assert.equal(run.data.args, 'echo one', 'args 必须是第一条命令')
    assert.deepEqual(run.data.source, { kind: 'user' })
    assert.deepEqual(done.data, {
      commandId: run.data.commandId,
      kind: 'success',
      text: '$ echo one\nhi\n$ echo two\nhi',
    })
    assert.deepEqual(calls.order, ['append:run', 'followup', 'append:done'])
    assert.equal(result.sent, true)
    assert.equal(registry.has('s1'), false, 'finish 成功后仍应删除 Host 会话状态')
  })

  it('R37 卡片记录不改变模型输入：followup 一次、text 不含 commandId/事件名/卡片正文之外的 header', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.send('s1', 'echo x')
    await registry.finish('s1')

    assert.equal(calls.followup, 1)
    const message = calls.messages[0]
    const commandId = calls.append[0].data.commandId
    assert.equal(message.source.kind, 'shell-command')
    assert.equal(message.source.command, 'echo x')
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text.includes(commandId), false)
    assert.equal(message.content[0].text.includes('command/run'), false)
    assert.equal(message.content[0].text.includes('command/done'), false)
    // 模型文本仍然是既有 header + cwd + transcript，未被 append 污染。
    assert.match(message.content[0].text, /interactive terminal session inside the DSH composer/u)
    assert.match(message.content[0].text, /cwd: \/tmp\/dsh-shell-cmd-workspace/u)
    assert.match(message.content[0].text, /\$ echo x/u)
  })

  it('R38 command/run 追加失败：不阻断 followup，且不补孤立 done', async () => {
    const { registry, calls } = createRegistryFixture({ appendFailsFor: 'command/run' })
    await registry.send('s1', 'echo x')

    const result = await registry.finish('s1')

    assert.deepEqual(calls.append.map((entry) => entry.type), ['command/run'])
    assert.equal(calls.followup, 1)
    assert.equal(result.sent, true)
    assert.equal(registry.has('s1'), false)
  })

  it('R39 command/done 追加失败：finish 仍成功、followup 一次、状态删除', async () => {
    const { registry, calls } = createRegistryFixture({ appendFailsFor: 'command/done' })
    await registry.send('s1', 'echo x')

    const result = await registry.finish('s1')

    assert.deepEqual(calls.append.map((entry) => entry.type), ['command/run', 'command/done'])
    assert.equal(calls.followup, 1)
    assert.equal(result.sent, true)
    assert.equal(registry.has('s1'), false)
  })

  it('R40 followup 抛错：补 kind=error 的 done（同一 commandId），错误原样抛出，状态保留', async () => {
    const { registry, calls } = createRegistryFixture({ followupThrows: true })
    await registry.send('s1', 'echo x')

    await assert.rejects(() => registry.finish('s1'), /followup failed/u)

    assert.deepEqual(calls.append.map((entry) => entry.type), ['command/run', 'command/done'])
    assert.equal(calls.append[1].data.kind, 'error')
    assert.equal(calls.append[0].data.commandId, calls.append[1].data.commandId)
    assert.match(String(calls.append[1].data.text), /followup failed/u)
    assert.equal(registry.has('s1'), true, '发送失败时不清理终端状态（原有语义）')
  })

  it('R41 close（Esc/点遮罩）绝不追加命令生命周期事件', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.open('s1')
    await registry.send('s1', 'echo x')

    assert.equal(registry.close('s1'), true)

    assert.deepEqual(calls.append, [])
    assert.equal(calls.followup, 0)
    assert.deepEqual(calls.order, [])
  })

  it('R42 第二次 finish 不重复追加：返回 empty，append 数量不变', async () => {
    const { registry, calls } = createRegistryFixture()
    await registry.send('s1', 'echo x')
    await registry.finish('s1')
    const appended = calls.append.length

    await assert.rejects(
      () => registry.finish('s1'),
      (error) => error.code === 'empty',
    )
    assert.equal(calls.append.length, appended)
    assert.equal(calls.followup, 1)
  })

  it('R43 会话没有 session.append：finish 仍成功（best-effort）', async () => {
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
  it('R44 terminal.js finish 追加的事件形状 / best-effort / close 不追加', () => {
    // 源码锁定：只对源码文本做断言，证明实现与 dsh commands 服务的事件形状一致，
    // **不是**运行时行为验证（行为由 R36-R43 的伪 agent 覆盖）。
    // 1) run 事件字段：commandId / name='cmd' / args=firstCommand / source.kind='user'
    assert.match(TERMINAL_SOURCE, /appendCommandLifecycle\(agent, 'command\/run', \{/u)
    assert.match(TERMINAL_SOURCE, /const commandId = `cmd-terminal-\$\{globalThis\.crypto\.randomUUID\(\)\}`/u)
    assert.match(TERMINAL_SOURCE, /name: 'cmd',\s*\n\s*args: firstCommand,\s*\n\s*source: \{ kind: 'user' \}/u)
    // 2) done 成功事件：kind='success'、text=transcript.text（不是 modelText / 说明头）
    assert.match(TERMINAL_SOURCE, /appendCommandLifecycle\(agent, 'command\/done', \{\s*\n\s*commandId,\s*\n\s*kind: 'success',\s*\n\s*text: transcript\.text,/u)
    // 3) followup 抛错路径补 kind='error' 的 done
    assert.match(TERMINAL_SOURCE, /kind: 'error',\s*\n\s*text: error instanceof Error \? error\.message : String\(error\)/u)
    // 4) 只有当 run 记录成功（recorded）时才补 done，避免孤儿事件
    assert.match(TERMINAL_SOURCE, /if \(recorded\) \{[\s\S]{0,200}appendCommandLifecycle\(agent, 'command\/done'/u)
    // 5) append 自身 try/catch 吞错（best-effort），且实现为 session.append(type, data)
    const appendFn = TERMINAL_SOURCE.slice(
      TERMINAL_SOURCE.indexOf('function appendCommandLifecycle'),
      TERMINAL_SOURCE.indexOf('function createTerminalRegistry'),
    )
    assert.match(appendFn, /try \{/u)
    assert.match(appendFn, /catch \{/u)
    assert.match(appendFn, /session\.append\(type, data\)/u)
    // 6) close 分支内没有任何 append（Esc 绝不产生卡片）
    const closeStart = TERMINAL_SOURCE.indexOf('close(sessionId) {')
    assert.ok(closeStart > 0)
    const closeBlock = TERMINAL_SOURCE.slice(closeStart, TERMINAL_SOURCE.indexOf('dispose() {', closeStart))
    assert.equal(closeBlock.includes('append'), false, 'close 分支不得追加命令事件')
    // 7) modelText 仍只由 followup 使用；append 的 success text 直接取 transcript.text
    assert.match(TERMINAL_SOURCE, /text: transcript\.text/u)
    assert.doesNotMatch(TERMINAL_SOURCE, /appendCommandLifecycle\(agent, 'command\/done', \{[\s\S]{0,200}MODEL_HEADER/u)
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

  it('R31 package.json：版本 0.3.13 且声明 commandUi 客户端依赖', () => {
    assert.equal(PACKAGE_JSON.version, '0.3.13')
    const inject = PACKAGE_JSON?.dsh?.client?.inject
    assert.equal(Array.isArray(inject), true)
    assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-commands'), '必须声明 @deepseek-ai/dsh-client-ui-commands')
    assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
    assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'))
    assert.ok(PACKAGE_JSON.files.includes('client.js'))
    assert.ok(PACKAGE_JSON.files.includes('terminal.js'))
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
})
