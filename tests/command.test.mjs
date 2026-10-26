/**
 * dsh-shell-cmd / Host 半端单元测试
 *
 * 覆盖 index.js 中所有纯函数与 executeShellCommand / apply 的编排逻辑。
 * 全程使用伪对象，不 spawn 真实进程、不依赖 dsh 安装、不联网。
 *
 * 运行：仓库根目录 `node --test tests/`
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  name as pluginName,
  inject,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_CHARS,
  STDOUT_MAX_BYTES,
  USAGE,
  clipText,
  composeBody,
  statusMarkers,
  composeCommandText,
  composeModelText,
  createShellCommandMessage,
  titleFromCommand,
  syncSessionTitle,
  executeShellCommand,
  apply,
} from '../index.js'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 构造一个结构完整的 ShellRunResult 伪对象。 */
function makeResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/**
 * 构造伪 ctx / agent / 可注入的消息工厂，并记录所有调用。
 * - state.result 可在测试中途替换，execute 每次读取最新值。
 */
function makeHarness({ result = makeResult(), executeError = null, ensureResult = '/tmp/work', sessionTitle = null } = {}) {
  const state = { result, executeError }
  const resolveCalls = []
  const executeCalls = []
  const followups = []
  const ensureCalls = []
  const createdMessages = []
  const createMessageCalls = []
  const session = { id: `session-${Math.random().toString(36).slice(2, 10)}` }

  const ctx = {
    workingDirectory: {
      ensure: async (...args) => {
        ensureCalls.push(args)
        return typeof ensureResult === 'function' ? ensureResult(...args) : ensureResult
      },
    },
    shell: {
      // 模拟真实 ShellService.resolve 的返回形态（携带 workdir）。
      resolve: (request) => {
        resolveCalls.push(request)
        return { ...request, workdir: request.workdir }
      },
      execute: async (spec) => {
        executeCalls.push(spec)
        if (state.executeError !== null) throw state.executeError
        return { result: async () => state.result }
      },
    },
    get: (name) => (name === 'sessionTitle' && sessionTitle !== null ? sessionTitle : undefined),
  }

  const agent = {
    session,
    followup: (message) => {
      followups.push(message)
    },
  }

  // 伪消息工厂：避免依赖 globalThis.crypto.randomUUID，且便于断言入参。
  const createMessage = (text, command) => {
    createMessageCalls.push({ text, command })
    const message = {
      id: `fake-message-${createMessageCalls.length}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'shell-command', command },
    }
    createdMessages.push(message)
    return message
  }

  return {
    state,
    ctx,
    agent,
    session,
    resolveCalls,
    executeCalls,
    followups,
    ensureCalls,
    createdMessages,
    createMessageCalls,
    createMessage,
  }
}

/**
 * 构造伪 sessionTitle 服务（get / rename），记录调用并维护最新快照。
 * @param {{ current?: object, renameThrows?: boolean, seqStart?: number }} [options]
 */
function makeTitleService({ current = undefined, renameThrows = false, seqStart = 10 } = {}) {
  const calls = []
  let state = current
  let seq = seqStart
  const service = {
    get: () => state,
    rename: (session, title) => {
      calls.push({ session, title })
      if (renameThrows) throw new Error('title rejected')
      state = {
        title,
        messageSeqs: [],
        source: { kind: 'user' },
        eventSeq: seq,
        updatedAt: Date.now(),
      }
      seq += 1
      return state
    },
  }
  return {
    service,
    calls,
    get current() {
      return state
    },
    setCurrent(value) {
      state = value
    },
  }
}

// ---------------------------------------------------------------------------
// 模块常量 / 导出
// ---------------------------------------------------------------------------

describe('模块导出', () => {
  it('导出插件名、注入服务与默认常量', () => {
    assert.equal(pluginName, 'dsh-shell-cmd')
    assert.deepEqual(inject, ['commands', 'shell', 'workingDirectory'])
    assert.equal(DEFAULT_TIMEOUT_MS, 120_000)
    assert.equal(DEFAULT_MAX_OUTPUT_CHARS, 24_000)
    assert.equal(STDOUT_MAX_BYTES, 256 * 1024)
    assert.equal(USAGE, 'Usage: /cmd <shell command>')
  })
})

// ---------------------------------------------------------------------------
// clipText
// ---------------------------------------------------------------------------

describe('clipText', () => {
  it('短文本不截断，原样返回', () => {
    const result = clipText('short text', 100)
    assert.deepEqual(result, { text: 'short text', truncated: false })
  })

  it('长度恰好等于上限时不截断', () => {
    const text = 'abcde'
    assert.deepEqual(clipText(text, 5), { text, truncated: false })
  })

  it('超限时保留头尾并插入省略标记', () => {
    const text = `HEAD-${'x'.repeat(900)}-TAIL`
    const result = clipText(text, 100)

    assert.equal(result.truncated, true)
    // max=100 → head=65, tail=35, omitted=910-100=810
    assert.equal(result.text.startsWith('HEAD-'), true)
    assert.equal(result.text.startsWith(text.slice(0, 65)), true)
    assert.equal(result.text.endsWith('-TAIL'), true)
    assert.equal(result.text.endsWith(text.slice(-35)), true)
    assert.equal(result.text.includes('\n… [810 characters omitted] …\n'), true)
    // 中部内容确实被丢弃（500 个连续 x 不在头部 60 个 / 尾部 30 个 x 的范围内）
    assert.equal(result.text.includes('x'.repeat(500)), false)
    assert.equal(result.text.length < text.length, true)
  })

  it('max<=0 时原样返回且不标记截断', () => {
    const text = 'y'.repeat(50)
    for (const max of [0, -1, -100]) {
      assert.deepEqual(clipText(text, max), { text, truncated: false }, `max=${max}`)
    }
  })

  it('max 为非有限值时原样返回且不标记截断', () => {
    const text = 'z'.repeat(50)
    for (const max of [NaN, Infinity, -Infinity]) {
      assert.deepEqual(clipText(text, max), { text, truncated: false }, `max=${String(max)}`)
    }
  })

  it('非字符串输入返回空文本', () => {
    assert.deepEqual(clipText(null, 10), { text: '', truncated: false })
    assert.deepEqual(clipText(undefined, 10), { text: '', truncated: false })
  })
})

// ---------------------------------------------------------------------------
// composeBody
// ---------------------------------------------------------------------------

describe('composeBody', () => {
  it('仅 stdout 时直接返回 stdout', () => {
    assert.equal(composeBody('hello\n', ''), 'hello\n')
    assert.equal(composeBody('hello', ''), 'hello')
  })

  it('stdout+stderr 时出现 [stderr] 段', () => {
    assert.equal(composeBody('hello\n', 'boom'), 'hello\n[stderr]\nboom')
  })

  it('stdout 末尾无换行时自动补一个换行再接 stderr', () => {
    assert.equal(composeBody('hello', 'boom'), 'hello\n[stderr]\nboom')
    // 补的换行只补一次，不会出现两个换行
    assert.equal(composeBody('hello', 'boom').includes('hello\n\n'), false)
  })

  it('仅 stderr 时正文以 [stderr] 开头', () => {
    assert.equal(composeBody('', 'boom'), '[stderr]\nboom')
  })

  it('两者皆空 → (no output)', () => {
    assert.equal(composeBody('', ''), '(no output)')
  })

  it('仅空白 stdout 视为空 → (no output)', () => {
    assert.equal(composeBody('   \n\t ', ''), '(no output)')
  })

  it('非字符串输入按空处理', () => {
    assert.equal(composeBody(undefined, undefined), '(no output)')
  })
})

// ---------------------------------------------------------------------------
// statusMarkers
// ---------------------------------------------------------------------------

describe('statusMarkers', () => {
  it('exitCode=0 且无异常状态时不产生任何标记', () => {
    assert.deepEqual(statusMarkers(makeResult()), [])
  })

  it('exitCode=null 视为成功语义，不产生退出码标记', () => {
    assert.deepEqual(statusMarkers(makeResult({ exitCode: null })), [])
  })

  it('exitCode=2 产生 [exit code: 2]', () => {
    assert.deepEqual(statusMarkers(makeResult({ exitCode: 2 })), ['[exit code: 2]'])
  })

  it('signal 产生 [killed by signal: SIGKILL]', () => {
    assert.deepEqual(statusMarkers(makeResult({ exitCode: null, signal: 'SIGKILL' })), [
      '[killed by signal: SIGKILL]',
    ])
  })

  it('timedOut 产生 [timed out after <timeoutMs>ms]', () => {
    assert.deepEqual(statusMarkers(makeResult({ exitCode: null, timedOut: true, timeoutMs: 5000 })), [
      '[timed out after 5000ms]',
    ])
  })

  it('stdout/stderr 被执行器截断时产生截断提示', () => {
    assert.deepEqual(statusMarkers(makeResult({ stdout: { text: 'a', truncated: true } })), [
      '[some output was truncated by the executor]',
    ])
    assert.deepEqual(statusMarkers(makeResult({ stderr: { text: 'b', truncated: true } })), [
      '[some output was truncated by the executor]',
    ])
  })

  it('aborted 产生 [aborted] 且不重复报信号', () => {
    assert.deepEqual(statusMarkers(makeResult({ exitCode: null, aborted: true, signal: 'SIGTERM' })), [
      '[aborted]',
    ])
  })
})

// ---------------------------------------------------------------------------
// composeCommandText（命令卡片正文）
// ---------------------------------------------------------------------------

describe('composeCommandText', () => {
  it('成功时返回正文与归一化状态字段', () => {
    const result = makeResult({ stdout: { text: 'hello world', truncated: false } })
    assert.deepEqual(composeCommandText(result), {
      text: 'hello world',
      exitCode: 0,
      timedOut: false,
      aborted: false,
    })
  })

  it('非零退出时追加 [exit code: 3] 标记行', () => {
    const result = makeResult({ exitCode: 3, stdout: { text: 'hello', truncated: false } })
    assert.equal(composeCommandText(result).text, 'hello\n[exit code: 3]')
  })

  it('超时结果正文含超时标记', () => {
    const result = makeResult({ exitCode: null, timedOut: true, timeoutMs: 7000 })
    const composed = composeCommandText(result)
    assert.equal(composed.text.endsWith('[timed out after 7000ms]'), true)
    assert.equal(composed.timedOut, true)
  })

  it('stdout 被截断时正文含执行器截断提示', () => {
    const result = makeResult({ stdout: { text: 'a', truncated: true } })
    assert.equal(
      composeCommandText(result).text.includes('[some output was truncated by the executor]'),
      true,
    )
  })

  it('超过 maxOutputChars 时正文含字符省略标记与顶部截断提示', () => {
    const result = makeResult({ stdout: { text: 'q'.repeat(1000), truncated: false } })
    const composed = composeCommandText(result, 200)
    assert.equal(composed.text.includes('characters omitted'), true)
    // 截断提示追加在正文末尾（markers 段）
    assert.equal(composed.text.endsWith('[output truncated for display]'), true)
    assert.equal(
      composed.text.indexOf('characters omitted') <
        composed.text.indexOf('[output truncated for display]'),
      true,
    )
    assert.equal(composed.text.length < 1000, true)
  })

  it('exitCode=null 归一化为 null 且不产生退出码标记', () => {
    const composed = composeCommandText(makeResult({ exitCode: null }))
    assert.equal(composed.exitCode, null)
    assert.equal(composed.text.includes('[exit code:'), false)
  })

  it('aborted=true 透传到返回值', () => {
    const composed = composeCommandText(makeResult({ exitCode: null, aborted: true }))
    assert.equal(composed.aborted, true)
    assert.equal(composed.text.includes('[aborted]'), true)
  })
})

// ---------------------------------------------------------------------------
// composeModelText（发给模型的 user 消息正文）
// ---------------------------------------------------------------------------

describe('composeModelText', () => {
  it('成功时包含执行声明、$ 命令、cwd、exit 与正文', () => {
    const result = makeResult({ stdout: { text: 'hello world', truncated: false } })
    const text = composeModelText({ command: 'echo hi', cwd: '/tmp/work', result })

    assert.equal(text.includes('The user ran the following shell command'), true)
    assert.equal(text.includes('$ echo hi'), true)
    assert.equal(text.includes('cwd: /tmp/work'), true)
    assert.equal(text.includes('exit: 0'), true)
    assert.equal(text.includes('hello world'), true)
    // 成功路径不应出现任何状态标记
    assert.equal(text.includes('[exit code:'), false)
    assert.equal(text.includes('[timed out after'), false)
  })

  it('非零退出时 exit 行与状态标记都体现退出码', () => {
    const result = makeResult({ exitCode: 2, stdout: { text: 'boom', truncated: false } })
    const text = composeModelText({ command: 'false-cmd', cwd: '/tmp/work', result })
    assert.equal(text.includes('exit: 2'), true)
    assert.equal(text.includes('[exit code: 2]'), true)
    assert.equal(text.includes('boom'), true)
  })

  it('被信号杀死时 exit 行写 signal', () => {
    const result = makeResult({ exitCode: null, signal: 'SIGKILL', stdout: { text: 'x' } })
    const text = composeModelText({ command: 'sleep 999', cwd: '/tmp/work', result })
    assert.equal(text.includes('exit: signal SIGKILL'), true)
    assert.equal(text.includes('[killed by signal: SIGKILL]'), true)
  })

  it('超时时 exit 行写 timed out 并带超时标记', () => {
    const result = makeResult({ exitCode: null, timedOut: true, timeoutMs: 1500 })
    const text = composeModelText({ command: 'sleep 999', cwd: '/tmp/work', result })
    assert.equal(text.includes('exit: timed out'), true)
    assert.equal(text.includes('[timed out after 1500ms]'), true)
  })

  it('exitCode=null 视为成功，exit 行写 0', () => {
    const text = composeModelText({ command: 'true', cwd: '/tmp/work', result: makeResult({ exitCode: null }) })
    assert.equal(text.includes('exit: 0'), true)
    assert.equal(text.includes('[exit code:'), false)
  })

  it('超过 maxOutputChars 时提示输出已为传输截断', () => {
    const result = makeResult({ stdout: { text: 'w'.repeat(1000), truncated: false } })
    const text = composeModelText({ command: 'big', cwd: '/tmp/work', result, maxOutputChars: 200 })
    assert.equal(text.includes('characters omitted'), true)
    assert.equal(text.includes('[the output above was truncated for transport]'), true)
  })
})

// ---------------------------------------------------------------------------
// createShellCommandMessage（真实消息工厂）
// ---------------------------------------------------------------------------

describe('createShellCommandMessage', () => {
  it('按 user 消息结构构造并写入 shell-command source', () => {
    const message = createShellCommandMessage('body text', 'echo hi')
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.equal(message.id.length, 36) // UUID v4 字符串
    assert.deepEqual(message.content, [{ type: 'text', text: 'body text' }])
    assert.deepEqual(message.source, { kind: 'shell-command', command: 'echo hi' })
  })
})

// ---------------------------------------------------------------------------
// executeShellCommand
// ---------------------------------------------------------------------------

describe('executeShellCommand', () => {
  it('rawInput 为空字符串时返回 usage 错误，且不碰 shell / followup / cwd', async () => {
    const h = makeHarness()
    const out = await executeShellCommand(h.ctx, { agent: h.agent, rawInput: '', signal: undefined })

    assert.deepEqual(out, { kind: 'error', text: USAGE })
    assert.equal(out.text.includes(USAGE), true)
    assert.equal(h.ensureCalls.length, 0)
    assert.equal(h.resolveCalls.length, 0)
    assert.equal(h.executeCalls.length, 0)
    assert.equal(h.followups.length, 0)
  })

  it('rawInput 纯空白时返回 usage 错误，且不碰 shell / followup / cwd', async () => {
    const h = makeHarness()
    const out = await executeShellCommand(h.ctx, {
      agent: h.agent,
      rawInput: '  \n\t   ',
      signal: undefined,
    })

    assert.deepEqual(out, { kind: 'error', text: USAGE })
    assert.equal(h.ensureCalls.length, 0)
    assert.equal(h.resolveCalls.length, 0)
    assert.equal(h.executeCalls.length, 0)
    assert.equal(h.followups.length, 0)
  })

  it('成功路径：resolve 请求字段正确、followup 恰好一次、消息结构完整', async () => {
    const h = makeHarness({
      result: makeResult({ exitCode: 0, stdout: { text: 'hello world', truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: '  echo hi  ', signal: undefined },
      { createMessage: h.createMessage },
    )

    // 返回值
    assert.deepEqual(out, { kind: 'success', text: 'hello world' })

    // 传入 shell.resolve 的请求：command 已 trim，含 workdir/timeoutMs/stdoutMaxBytes，且没有 sandboxPolicy
    assert.equal(h.resolveCalls.length, 1)
    const request = h.resolveCalls[0]
    assert.equal(request.command, 'echo hi')
    assert.equal(request.workdir, '/tmp/work')
    assert.equal(request.timeoutMs, DEFAULT_TIMEOUT_MS)
    assert.equal(request.stdoutMaxBytes, STDOUT_MAX_BYTES)
    assert.equal(request.onExpiry, 'kill')
    assert.equal(Object.hasOwn(request, 'sandboxPolicy'), false)
    // 没有传入 signal 时不带 signal 字段
    assert.equal(Object.hasOwn(request, 'signal'), false)

    // shell.execute 收到 resolve 产物的派生 spec，且 cwd 取 spec.workdir
    assert.equal(h.executeCalls.length, 1)
    assert.equal(h.executeCalls[0].command, 'echo hi')
    assert.equal(h.executeCalls[0].workdir, '/tmp/work')
    assert.equal(h.executeCalls[0].timeoutMs, DEFAULT_TIMEOUT_MS)

    // followup 恰好一次，且收到的就是注入工厂返回的消息对象
    assert.equal(h.followups.length, 1)
    assert.equal(h.followups[0], h.createdMessages[0])

    // 注入工厂被调用一次，入参为 (modelText, command)
    assert.equal(h.createMessageCalls.length, 1)
    assert.equal(h.createMessageCalls[0].command, 'echo hi')

    // 消息结构
    const message = h.followups[0]
    assert.equal(message.source.kind, 'shell-command')
    assert.equal(message.source.command, 'echo hi')
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text, h.createMessageCalls[0].text)
    assert.equal(message.content[0].text.includes('$ echo hi'), true)
    assert.equal(message.content[0].text.includes('hello world'), true)
    assert.equal(message.content[0].text.includes('cwd: /tmp/work'), true)
  })

  it('非零退出仍返回 success，但正文含 [exit code: 3]', async () => {
    const h = makeHarness({
      result: makeResult({ exitCode: 3, stdout: { text: 'partial', truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'exit 3', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'success')
    assert.equal(out.text.includes('[exit code: 3]'), true)
    assert.equal(out.text.startsWith('partial'), true)
    assert.equal(h.followups.length, 1)
    assert.equal(h.followups[0].content[0].text.includes('[exit code: 3]'), true)
  })

  it('timedOut=true 返回 error 且正文含超时标记', async () => {
    const h = makeHarness({
      result: makeResult({ exitCode: null, timedOut: true, timeoutMs: 4321 }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'sleep 999', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'error')
    assert.equal(out.text.includes('[timed out after 4321ms]'), true)
    // 超时结果仍会把输出交给模型（除非被取消）
    assert.equal(h.followups.length, 1)
    assert.equal(h.followups[0].content[0].text.includes('[timed out after 4321ms]'), true)
  })

  it('shell.execute reject → error 且以 "Failed to run command:" 开头，不 followup', async () => {
    const h = makeHarness({ executeError: new Error('kaput') })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'boom', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'error')
    assert.equal(out.text.startsWith('Failed to run command:'), true)
    assert.equal(out.text, 'Failed to run command: kaput')
    assert.equal(h.followups.length, 0)
  })

  it('signal.aborted=true 且 execute reject → error，正文为 Command cancelled.', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = makeHarness({ executeError: new Error('killed') })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'long-job', signal: controller.signal },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'error')
    assert.equal(out.text, 'Command cancelled.')
    assert.equal(h.followups.length, 0)
    // 取消信号确实透传给了 shell.resolve
    assert.equal(h.resolveCalls.length, 1)
    assert.equal(h.resolveCalls[0].signal, controller.signal)
  })

  it('result.aborted=true → error，正文说明未发送给模型，且不 followup', async () => {
    const h = makeHarness({
      result: makeResult({ exitCode: null, aborted: true, stdout: { text: 'half done', truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'long-job', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'error')
    assert.equal(out.text.includes('half done'), true)
    assert.equal(out.text.includes('[aborted]'), true)
    assert.equal(out.text.includes('was not sent to the model'), true)
    assert.equal(h.followups.length, 0)
    assert.equal(h.createMessageCalls.length, 0)
  })

  it('followup 抛错 → error，正文同时含输出片段与发送失败说明', async () => {
    const h = makeHarness({
      result: makeResult({ exitCode: 0, stdout: { text: 'visible output', truncated: false } }),
    })
    h.agent.followup = () => {
      throw new Error('transport down')
    }

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'echo visible', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'error')
    assert.equal(out.text.includes('visible output'), true)
    assert.equal(out.text.includes('could not be sent to the model'), true)
    assert.equal(out.text.includes('transport down'), true)
    assert.equal(h.createMessageCalls.length, 1) // 消息已构造，只是发送失败
  })

  it('超长 stdout + maxOutputChars=200 → 正文含 characters omitted', async () => {
    const h = makeHarness({
      result: makeResult({ exitCode: 0, stdout: { text: 'x'.repeat(1000), truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'big-output', signal: undefined },
      { maxOutputChars: 200, createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'success')
    assert.equal(out.text.includes('characters omitted'), true)
    assert.equal(out.text.length < 1000, true)
    // 模型消息同样被截断，并带传输截断提示
    assert.equal(h.followups[0].content[0].text.includes('characters omitted'), true)
    assert.equal(
      h.followups[0].content[0].text.includes('[the output above was truncated for transport]'),
      true,
    )
  })

  it('options.timeoutMs=1234 会传给 shell.resolve', async () => {
    const h = makeHarness({ result: makeResult({ stdout: { text: 'ok' } }) })

    await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'echo ok', signal: undefined },
      { timeoutMs: 1234, createMessage: h.createMessage },
    )

    assert.equal(h.resolveCalls.length, 1)
    assert.equal(h.resolveCalls[0].timeoutMs, 1234)
  })
})

// ---------------------------------------------------------------------------
// 会话标题
// ---------------------------------------------------------------------------

describe('titleFromCommand', () => {
  it('把多行 / 连续空白折叠为一行并去掉首尾空白', () => {
    assert.equal(titleFromCommand('  echo   hi  '), 'echo hi')
    assert.equal(titleFromCommand('a\n  b\tc '), 'a b c')
  })

  it('非字符串返回空串', () => {
    assert.equal(titleFromCommand(undefined), '')
    assert.equal(titleFromCommand(null), '')
    assert.equal(titleFromCommand(42), '')
  })
})

describe('syncSessionTitle', () => {
  it('会话尚无标题时用命令命名', () => {
    const title = makeTitleService()
    const h = makeHarness({ sessionTitle: title.service })

    const written = syncSessionTitle(h.ctx, h.agent, '  echo   hi  ')

    assert.equal(written, true)
    assert.deepEqual(title.calls, [{ session: h.session, title: 'echo hi' }])
    assert.equal(title.current.title, 'echo hi')
    assert.equal(title.current.source.kind, 'user')
  })

  it('已有自动标题（provider/fallback）时覆盖为命令', () => {
    const title = makeTitleService({
      current: { title: 'auto title', messageSeqs: [], source: { kind: 'provider' }, eventSeq: 3, updatedAt: 1 },
    })
    const h = makeHarness({ sessionTitle: title.service })

    const written = syncSessionTitle(h.ctx, h.agent, 'git status')

    assert.equal(written, true)
    assert.equal(title.calls.length, 1)
    assert.equal(title.calls[0].title, 'git status')
  })

  it('人工命名的标题不覆盖', () => {
    const title = makeTitleService({
      current: { title: 'my session', messageSeqs: [], source: { kind: 'user' }, eventSeq: 7, updatedAt: 1 },
    })
    const h = makeHarness({ sessionTitle: title.service })

    const written = syncSessionTitle(h.ctx, h.agent, 'echo hi')

    assert.equal(written, false)
    assert.equal(title.calls.length, 0)
  })

  it('本插件写入过标题时会随最新命令更新', () => {
    const title = makeTitleService()
    const h = makeHarness({ sessionTitle: title.service })

    assert.equal(syncSessionTitle(h.ctx, h.agent, 'first cmd'), true)
    assert.equal(syncSessionTitle(h.ctx, h.agent, 'second cmd'), true)

    assert.equal(title.calls.length, 2)
    assert.equal(title.calls[1].title, 'second cmd')
    assert.equal(title.current.title, 'second cmd')
  })

  it('本插件写入后若用户手动改名，则之后不再覆盖', () => {
    const title = makeTitleService()
    const h = makeHarness({ sessionTitle: title.service })
    assert.equal(syncSessionTitle(h.ctx, h.agent, 'first cmd'), true)

    // 模拟用户随后手动改名（source 仍是 user，但 eventSeq 变了）。
    title.setCurrent({
      title: 'manual title',
      messageSeqs: [],
      source: { kind: 'user' },
      eventSeq: 99,
      updatedAt: 2,
    })

    const written = syncSessionTitle(h.ctx, h.agent, 'later cmd')
    assert.equal(written, false)
    assert.equal(title.calls.length, 1)
  })

  it('缺少 sessionTitle 服务 / session / rename 能力时安全跳过', () => {
    const noService = makeHarness({ sessionTitle: null })
    assert.equal(syncSessionTitle(noService.ctx, noService.agent, 'echo hi'), false)

    const withoutGet = makeHarness()
    assert.equal(syncSessionTitle({ shell: {} }, withoutGet.agent, 'echo hi'), false)

    const noSession = makeHarness({ sessionTitle: makeTitleService().service })
    assert.equal(syncSessionTitle(noSession.ctx, { followup() {} }, 'echo hi'), false)
  })

  it('rename 抛错时返回 false 且不抛出', () => {
    const title = makeTitleService({ renameThrows: true })
    const h = makeHarness({ sessionTitle: title.service })

    assert.equal(syncSessionTitle(h.ctx, h.agent, 'echo hi'), false)
    assert.equal(title.calls.length, 1)
  })
})

describe('executeShellCommand 与会话标题', () => {
  it('执行前用修剪后的命令命名会话，并照常 followup', async () => {
    const title = makeTitleService()
    const h = makeHarness({
      sessionTitle: title.service,
      result: makeResult({ exitCode: 0, stdout: { text: 'hello', truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: '  echo hi  ', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'success')
    assert.equal(title.calls.length, 1)
    assert.equal(title.calls[0].session, h.session)
    assert.equal(title.calls[0].title, 'echo hi')
    assert.equal(h.followups.length, 1)
  })

  it('nameSession=false 时只执行命令、不改会话标题', async () => {
    const title = makeTitleService()
    const h = makeHarness({
      sessionTitle: title.service,
      result: makeResult({ exitCode: 0, stdout: { text: 'ok', truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'echo ok', signal: undefined },
      { nameSession: false, createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'success')
    assert.equal(title.calls.length, 0)
    assert.equal(h.followups.length, 1)
  })

  it('命名失败（rename 抛错）不影响命令执行与模型消息', async () => {
    const title = makeTitleService({ renameThrows: true })
    const h = makeHarness({
      sessionTitle: title.service,
      result: makeResult({ exitCode: 0, stdout: { text: 'ok', truncated: false } }),
    })

    const out = await executeShellCommand(
      h.ctx,
      { agent: h.agent, rawInput: 'echo ok', signal: undefined },
      { createMessage: h.createMessage },
    )

    assert.equal(out.kind, 'success')
    assert.equal(out.text, 'ok')
    assert.equal(h.followups.length, 1)
  })
})

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

describe('apply', () => {
  it('注册 /cmd 命令定义（name/description/input.hint/handler）', () => {
    const registered = []
    const h = makeHarness()
    const ctx = {
      ...h.ctx,
      commands: {
        register: (definition) => registered.push(definition),
      },
    }

    apply(ctx)

    assert.equal(registered.length, 1)
    const definition = registered[0]
    assert.equal(definition.name, 'cmd')
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.description.length > 0, true)
    assert.equal(typeof definition.input, 'object')
    assert.equal(typeof definition.input.hint, 'string')
    assert.equal(definition.input.hint.length > 0, true)
    assert.equal(typeof definition.handler, 'function')
  })

  it('handler 委托给 executeShellCommand：空 rawInput 走 usage 错误分支', async () => {
    const registered = []
    const h = makeHarness()
    const ctx = {
      ...h.ctx,
      commands: {
        register: (definition) => registered.push(definition),
      },
    }
    apply(ctx)

    const out = await registered[0].handler({ agent: h.agent, rawInput: '', signal: undefined })

    assert.deepEqual(out, { kind: 'error', text: USAGE })
    assert.equal(h.ensureCalls.length, 0)
    assert.equal(h.resolveCalls.length, 0)
    assert.equal(h.followups.length, 0)
  })

  it('config 中的 timeoutMs / maxOutputChars 透传到执行流程', async () => {
    const registered = []
    const h = makeHarness({
      result: makeResult({ exitCode: 0, stdout: { text: 'y'.repeat(500), truncated: false } }),
    })
    const ctx = {
      ...h.ctx,
      commands: {
        register: (definition) => registered.push(definition),
      },
    }
    apply(ctx, { timeoutMs: 1234, maxOutputChars: 50 })

    const out = await registered[0].handler({ agent: h.agent, rawInput: 'echo big', signal: undefined })

    assert.equal(out.kind, 'success')
    assert.equal(h.resolveCalls[0].timeoutMs, 1234)
    assert.equal(out.text.includes('characters omitted'), true)
    // 未注入 createMessage，使用默认工厂：消息仍应是一条 user 消息
    assert.equal(h.followups.length, 1)
    assert.equal(h.followups[0].role, 'user')
    assert.equal(h.followups[0].source.kind, 'shell-command')
    assert.equal(h.followups[0].source.command, 'echo big')
  })
})
