/**
 * dsh-shell-cmd · Client 半端（单文件自包含 classic script）
 *
 * 形态约束：
 * - 本文件是宿主 `window.__ModuleLoader__` 的懒工厂注册脚本，id 必须等于包名。
 * - 不能 import / require 任何相对文件或其它 Client 包；只能 `require('react')`。
 * - 无 JSX：全部 `React.createElement`。
 * - 样式通过 `<style data-plugin-css>` 注入，并在 `ctx.effect` 清理函数里移除。
 *
 * 职责：把 `/cmd` 命令记录（`CommandNode`）渲染成终端卡片。
 * 注册点：`conversation.chat.commandview` 键控槽，key = 命令名 `cmd`。
 * `CommandNode` 结构（Host 侧 command/run + command/done 折叠而来）：
 *   { kind: 'command', seq, time, commandId, name: 'cmd'|null, args: string|null,
 *     outcome: null | { kind: 'success'|'error', text?: string, sourceEventSeq?: number } }
 */

window.__ModuleLoader__.load({
  id: 'dsh-shell-cmd',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-shell-cmd'

    /** 文案字典：en 为兜底，zh 为中文界面。 */
    const en = {
      'status.running': 'Running…',
      'status.done': 'Done',
      'status.exit': 'exit {code}',
      'status.timedOut': 'Timed out',
      'status.aborted': 'Cancelled',
      'output.empty': '(no output)',
      'output.showAll': 'Show all {n} lines',
      'output.showLess': 'Collapse',
      'output.truncated': 'output was truncated',
      'output.stderr': 'stderr included',
      'action.copy': 'Copy command and output',
      'action.copied': 'Copied',
      'action.copyFailed': 'Copy failed',
      'card.label': 'Shell command',
      'hint.active': 'Shell command mode: the command runs first, then the command and its output are sent to the model.',
      'terminal.title': 'Interactive terminal',
      'terminal.cwd': 'cwd {path}',
      'terminal.running': 'Running…',
      'terminal.idle': 'Ready',
      'terminal.sent': 'Sent to the model',
      'terminal.placeholder': 'Type a command and press Enter',
      'terminal.hint': 'Enter runs · Ctrl+C interrupts · Ctrl+Enter sends to the model · Esc closes',
      'terminal.send': 'Send to model (Ctrl+Enter)',
      'terminal.close': 'Close',
      'terminal.cancel': 'Interrupt',
      'terminal.empty': 'Run at least one command before sending.',
      'terminal.loading': 'Opening terminal…',
    }

    const zh = {
      'status.running': '执行中…',
      'status.done': '完成',
      'status.exit': '退出 {code}',
      'status.timedOut': '已超时',
      'status.aborted': '已取消',
      'output.empty': '（无输出）',
      'output.showAll': '展开全部 {n} 行',
      'output.showLess': '收起',
      'output.truncated': '输出已截断',
      'output.stderr': '含 stderr',
      'action.copy': '复制命令与输出',
      'action.copied': '已复制',
      'action.copyFailed': '复制失败',
      'card.label': '终端命令',
      'hint.active': '终端命令模式：先执行命令，再把命令与输出一起发给模型。',
      'terminal.title': '交互终端',
      'terminal.cwd': 'cwd {path}',
      'terminal.running': '执行中…',
      'terminal.idle': '就绪',
      'terminal.sent': '已发送给模型',
      'terminal.placeholder': '输入命令后回车执行',
      'terminal.hint': 'Enter 执行 · Ctrl+C 中断 · Ctrl+Enter 发送给模型 · Esc 关闭',
      'terminal.send': '发送给模型 (Ctrl+Enter)',
      'terminal.close': '关闭',
      'terminal.cancel': '中断',
      'terminal.empty': '至少执行一条命令后才能发送。',
      'terminal.loading': '正在打开终端…',
    }

    /** 卡片样式；颜色一律走宿主主题令牌，明暗主题自动跟随。 */
    const CSS = `
.dsc-card {
  display: block;
  margin: 2px 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
  font-size: 12px;
}
.dsc-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
}
.dsc-glyph {
  flex: none;
  display: flex;
  align-items: center;
  color: var(--dsw-alias-label-secondary);
  margin-top: 1px;
}
.dsc-cmd {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsc-prompt {
  color: var(--dsw-alias-label-secondary);
  user-select: none;
}
.dsc-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dsc-pill[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
.dsc-pill[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dsc-pill[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dsc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: dsc-pulse 1.1s ease-in-out infinite;
}
@keyframes dsc-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dsc-dot { animation: none; } }
.dsc-body-wrap {
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dsc-body {
  margin: 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsc-body-empty { color: var(--dsw-alias-label-secondary); }
.dsc-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dsc-note {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsc-btn {
  flex: none;
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  padding: 0 7px;
  cursor: pointer;
}
.dsc-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsc-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-top: 4px;
  padding: 2px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 18px;
}
.dsc-hint-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
  animation: dsc-pulse 1.1s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .dsc-hint-dot { animation: none; } }
.dsc-hint-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsc-term {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  align-self: stretch;
  margin: 6px 0 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
  font-size: 12px;
}
.dsc-term-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.dsc-term-title { flex: none; font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsc-term-cwd {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.dsc-term-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.dsc-term-status[data-tone="running"] { color: var(--dsw-alias-state-warn-primary); }
.dsc-term-status[data-tone="sent"] { color: var(--dsw-alias-state-success-primary); }
.dsc-term-body {
  display: block;
  margin: 0;
  padding: 8px 10px;
  height: 220px;
  overflow: auto;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsc-term-body-empty { color: var(--dsw-alias-label-secondary); }
.dsc-term-error { padding: 4px 10px; color: var(--dsw-alias-state-error-primary); font-size: 11.5px; }
.dsc-term-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 4px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsc-term-prompt {
  flex: none;
  color: var(--dsw-alias-state-success-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.dsc-term-input {
  flex: 1 1 auto;
  min-width: 0;
  appearance: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  padding: 2px 0;
}
.dsc-term-input:disabled { color: var(--dsw-alias-label-secondary); }
.dsc-term-hint {
  padding: 0 10px 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.dsc-term-note { padding: 4px 10px; color: var(--dsw-alias-state-success-primary); font-size: 11.5px; }
`

    /** 注入卡片样式，返回卸载清理函数。 */
    function insertStyle() {
      const el = document.createElement('style')
      el.setAttribute('data-plugin-css', 'dsh-shell-cmd/card.css')
      el.textContent = CSS
      document.head.appendChild(el)
      return () => {
        el.remove()
      }
    }

    /** 尾部状态标记行 → 结构化状态。标记由 Host 半端在文本末尾追加。 */
    const MARKER_RE =
      /^\[(?:exit code: (\d+)|timed out after (\d+)ms|aborted|killed by signal: ([^\]\n]+)|output truncated before display|some output was truncated by the executor)\]$/

    /**
     * 从命令输出文本中剥离尾部状态标记。
     * @param {string} text `CommandNode.outcome.text`
     * @returns {{ body: string, exitCode: number | null, timedOut: boolean, aborted: boolean, signal: string | null, truncated: boolean }}
     */
    function parseCommandText(text) {
      const lines = String(text ?? '').split('\n')
      const state = { exitCode: null, timedOut: false, aborted: false, signal: null, truncated: false }
      while (lines.length > 0) {
        const match = MARKER_RE.exec(lines[lines.length - 1])
        if (match === null) break
        if (match[1] !== undefined) state.exitCode = Number(match[1])
        else if (match[2] !== undefined) state.timedOut = true
        else if (lines[lines.length - 1] === '[aborted]') state.aborted = true
        else if (match[3] !== undefined) state.signal = match[3]
        else state.truncated = true
        lines.pop()
      }
      return { body: lines.join('\n'), ...state }
    }

    /** 终端小图标（纯装饰）。 */
    function TerminalGlyph() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', {
          d: 'M4.6 6.4 6.4 8l-1.8 1.6M7.8 9.9h3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * `/cmd` 命令行渲染器。
     * @param {{ node: object }} props `CommandRowOwnerProps`
     */
    function ShellCommandCard(props) {
      const node = props.node ?? {}
      const outcome = node.outcome ?? null
      const args = typeof node.args === 'string' ? node.args : ''
      const command = args.trim().length > 0 ? args.trim() : 'cmd'
      const parsed = parseCommandText(outcome?.text ?? '')
      const body = parsed.body.length > 0 ? parsed.body : ''
      const lines = body.length > 0 ? body.split('\n') : []
      const long = lines.length > 10 || body.length > 1200
      const [expanded, setExpanded] = React.useState(false)
      const [copyState, setCopyState] = React.useState('idle')

      // 裸 /cmd 的 CommandResult 只用来打开交互终端：卡片本身不渲染；
      // 只在“刚发生”时触发，避免回放历史记录时误开终端。
      const opensTerminal =
        args.trim().length === 0 &&
        typeof outcome?.text === 'string' &&
        outcome.text.startsWith(TERMINAL_MARKER) &&
        typeof node.time === 'number' &&
        Date.now() - node.time < TERMINAL_OPEN_FRESH_MS
      React.useEffect(() => {
        if (opensTerminal) setTerminalOpen(props.sessionId, true)
      }, [opensTerminal, props.sessionId, node.seq])
      if (opensTerminal) return null

      const t = typeof props.t === 'function' ? props.t : null
      const tr = (key, params) => {
        if (t !== null) {
          try {
            return t(key, params)
          } catch {
            /* 宿主 locale 未就绪时回退到内置英文，避免整张卡片崩溃 */
          }
        }
        const dict = en
        let value = dict[key] ?? key
        if (params !== undefined && params !== null) {
          for (const name of Object.keys(params)) value = value.split(`{${name}}`).join(String(params[name]))
        }
        return value
      }

      const running = outcome === null
      const tone = running
        ? 'idle'
        : parsed.timedOut
          ? 'warn'
          : parsed.aborted
            ? 'error'
            : parsed.exitCode !== null
              ? parsed.exitCode === 0
                ? 'success'
                : 'error'
              : outcome?.kind === 'error'
                ? 'error'
                : 'success'
      const statusText = running
        ? tr('status.running')
        : parsed.timedOut
          ? tr('status.timedOut')
          : parsed.aborted
            ? tr('status.aborted')
            : parsed.exitCode !== null
              ? tr('status.exit', { code: parsed.exitCode })
              : outcome?.kind === 'error'
                ? tr('status.aborted')
                : tr('status.done')

      const shown = long && !expanded ? lines.slice(0, 10).join('\n') : body

      const copy = () => {
        const payload = `$ ${command}\n${body}`
        const done = () => {
          setCopyState('copied')
          window.setTimeout(() => setCopyState('idle'), 1200)
        }
        const failed = () => {
          setCopyState('failed')
          window.setTimeout(() => setCopyState('idle'), 1200)
        }
        try {
          const clipboard = navigator.clipboard
          if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
            const pending = clipboard.writeText(payload)
            if (pending !== undefined && typeof pending.then === 'function') pending.then(done, failed)
            else done()
          } else {
            failed()
          }
        } catch {
          failed()
        }
      }

      const notes = []
      if (parsed.signal !== null) notes.push(`signal ${parsed.signal}`)
      if (parsed.truncated) notes.push(tr('output.truncated'))

      return h(
        'div',
        { className: 'dsc-card', 'data-command': 'cmd' },
        h(
          'div',
          { className: 'dsc-head' },
          h('span', { className: 'dsc-glyph', title: tr('card.label') }, h(TerminalGlyph)),
          h(
            'div',
            { className: 'dsc-cmd' },
            h('span', { className: 'dsc-prompt' }, `${tr('card.label')}  $ `),
            h('span', { className: 'dsc-cmd-text' }, command),
          ),
          h(
            'span',
            { className: 'dsc-pill', 'data-tone': tone },
            running ? h('span', { className: 'dsc-dot', 'aria-hidden': 'true' }) : null,
            statusText,
          ),
        ),
        h(
          'div',
          { className: 'dsc-body-wrap' },
          h('pre', {
            className: body.length > 0 ? 'dsc-body' : 'dsc-body dsc-body-empty',
            'aria-label': tr('card.label'),
          }, body.length > 0 ? shown : tr('output.empty')),
        ),
        h(
          'div',
          { className: 'dsc-foot' },
          h('span', { className: 'dsc-note' }, notes.join(' · ')),
          long
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-btn',
                  onClick: () => setExpanded((value) => !value),
                  'aria-expanded': expanded,
                },
                expanded ? tr('output.showLess') : tr('output.showAll', { n: lines.length }),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'dsc-btn', onClick: copy, 'aria-label': tr('action.copy') },
            copyState === 'copied'
              ? tr('action.copied')
              : copyState === 'failed'
                ? tr('action.copyFailed')
                : tr('action.copy'),
          ),
        ),
      )
    }

    /**
     * 判断当前草稿是否已经进入 `/cmd` 模式（下拉菜单认领或直接键入）。
     * @param {unknown} draft 输入框的 clipboard-text 投影
     * @param {unknown} claimName 已认领的命令名（`InputState.claim.name`）
     * @returns {boolean}
     */
    function isShellCommandDraft(draft, claimName) {
      if (claimName === 'cmd') return true
      if (typeof draft !== 'string') return false
      return /^\/cmd(?:\s|$)/i.test(draft.trimStart())
    }

    /**
     * 输入框下方的“终端命令模式”提示条：只在草稿进入 /cmd 模式时出现。
     * @param {{ useInput: Function, t?: Function }} props
     */
    function ShellCmdHint(props) {
      if (typeof props.useInput !== 'function') return null
      const draft = props.useInput((state) => (typeof state?.draft === 'string' ? state.draft : ''))
      const claimName = props.useInput((state) => (typeof state?.claim?.name === 'string' ? state.claim.name : ''))
      const active = isShellCommandDraft(draft, claimName)
      if (!active) return null
      const label = typeof props.t === 'function' ? props.t('hint.active') : en['hint.active']
      return h(
        'div',
        { className: 'dsc-hint', role: 'status' },
        h('span', { className: 'dsc-hint-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsc-hint-text' }, label),
      )
    }

    // ------------------------------------------------------------------
    // 交互终端：打开状态（按 session）、RPC 客户端与面板
    // ------------------------------------------------------------------

    /** Host 半端注册的固定 HTTP RPC 路径（与 terminal.js 的 TERMINAL_ROUTE 一致）。 */
    const TERMINAL_RPC = '/cmd-terminal/rpc'
    /** 共享 `/api` 通道上的端点名（与 terminal.js 的 TERMINAL_RPC_ENDPOINT 一致）。 */
    const TERMINAL_RPC_ENDPOINT = 'cmd-terminal/rpc'
    /**
     * Client 侧 `ctx.connection.rpc`（Desktop 的 dsh-app 页面首选传输）。
     * 在 `apply` 里赋值；为空时退回同源 HTTP fetch。
     */
    let terminalHostRpc = null
    /** 裸 /cmd 的打开标记（与 terminal.js 的 OPEN_MARKER 一致）。 */
    const TERMINAL_MARKER = '[[dsh-shell-cmd:terminal]]'
    /** 只对“刚发生”的命令行打开终端，避免回放历史时误触发。 */
    const TERMINAL_OPEN_FRESH_MS = 15000

    /** sessionId → 是否打开终端面板。 */
    const terminalOpenState = new Map()
    const terminalListeners = new Set()

    function notifyTerminalListeners() {
      for (const listener of terminalListeners) {
        try {
          listener()
        } catch {
          /* 单个订阅者异常不影响其它订阅者 */
        }
      }
    }

    /** 设置某个会话的终端面板开关。 */
    function setTerminalOpen(sessionId, open) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const previous = terminalOpenState.get(sessionId) === true
      terminalOpenState.set(sessionId, open)
      if (previous !== open) notifyTerminalListeners()
    }

    /** 订阅某个会话的终端面板开关。 */
    function useTerminalOpen(sessionId) {
      const subscribe = (listener) => {
        terminalListeners.add(listener)
        return () => terminalListeners.delete(listener)
      }
      const getSnapshot = () => typeof sessionId === 'string' && terminalOpenState.get(sessionId) === true
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /** 调用 Host 的终端 RPC：优先共享 `/api` 通道，其次同源 HTTP。 */
    async function terminalRpc(sessionId, method, params) {
      const payload = { method, params: { sessionId, ...(params ?? {}) } }
      if (typeof terminalHostRpc === 'function') {
        const response = await terminalHostRpc('/api', TERMINAL_RPC_ENDPOINT, payload)
        if (response === null || typeof response !== 'object') throw new Error('terminal: empty rpc response')
        if (response.ok !== true) {
          const message = response.error?.message ?? response.error?.code ?? 'terminal rpc failed'
          throw new Error(message)
        }
        return response.value
      }
      const response = await fetch(TERMINAL_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      if (json === null || json.ok !== true) {
        const message = json?.error?.message ?? `HTTP ${response.status}`
        throw new Error(message)
      }
      return json.value
    }

    /** 与卡片一致的翻译函数（带英文兜底）。 */
    function makeTranslator(t) {
      return (key, params) => {
        if (typeof t === 'function') {
          try {
            return t(key, params)
          } catch {
            /* 宿主 locale 未就绪时回退到内置英文 */
          }
        }
        let value = en[key] ?? key
        if (params !== undefined && params !== null) {
          for (const name of Object.keys(params)) value = value.split(`{${name}}`).join(String(params[name]))
        }
        return value
      }
    }

    /**
     * 交互终端面板：输出滚动区 + 单行输入 + 快捷键。
     * Enter 执行、Ctrl+C 中断、Ctrl+Enter 发送给模型、Esc 关闭。
     * @param {{ sessionId: string, tr: Function }} props
     */
    function TerminalView(props) {
      const { sessionId, tr } = props
      const [lines, setLines] = React.useState([])
      const [cwd, setCwd] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [sent, setSent] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [value, setValue] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const bodyRef = React.useRef(null)
      const inputRef = React.useRef(null)

      const applySnapshot = (snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object') return
        if (Array.isArray(snapshot.lines)) setLines(snapshot.lines)
        if (typeof snapshot.cwd === 'string' && snapshot.cwd.length > 0) setCwd(snapshot.cwd)
        if (snapshot.sent === true) setSent(true)
      }

      React.useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        setSent(false)
        setLines([])
        terminalRpc(sessionId, 'open').then(
          (snapshot) => {
            if (cancelled) return
            applySnapshot(snapshot)
            setLoading(false)
          },
          (cause) => {
            if (cancelled) return
            setError(cause instanceof Error ? cause.message : String(cause))
            setLoading(false)
          },
        )
        return () => {
          cancelled = true
        }
      }, [sessionId])

      React.useEffect(() => {
        const element = bodyRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [lines, busy, loading])

      React.useEffect(() => {
        // 命令执行结束（busy 变 false）后把焦点还给输入行：用户不应再点一次鼠标。
        if (!loading && !sent && !busy) inputRef.current?.focus()
      }, [loading, sent, busy])

      const close = () => {
        terminalRpc(sessionId, 'close').catch(() => {})
        setTerminalOpen(sessionId, false)
      }

      const send = async () => {
        if (sent) return
        if (busy) {
          setError(tr('terminal.running'))
          return
        }
        if (value.trim().length === 0) return
        const text = value
        setBusy(true)
        setError(null)
        setValue('')
        try {
          applySnapshot(await terminalRpc(sessionId, 'send', { text }))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }

      const finish = async () => {
        if (busy) {
          setError(tr('terminal.running'))
          return
        }
        if (sent) return
        const hasCommand = lines.some((line) => typeof line === 'string' && line.startsWith('$ '))
        if (!hasCommand) {
          setError(tr('terminal.empty'))
          return
        }
        setError(null)
        try {
          applySnapshot(await terminalRpc(sessionId, 'finish'))
          setSent(true)
          // Ctrl+Enter 发送成功后终端面板直接消失，把位置还给输入框。
          setTerminalOpen(sessionId, false)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }

      const interrupt = () => {
        if (busy) {
          terminalRpc(sessionId, 'cancel').catch(() => {})
          return
        }
        setValue('')
      }

      const onKeyDown = (event) => {
        if (event.nativeEvent !== undefined && event.nativeEvent.isComposing === true) return
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault()
          event.stopPropagation()
          void finish()
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          void send()
          return
        }
        if ((event.key === 'c' || event.key === 'C') && event.ctrlKey) {
          event.preventDefault()
          interrupt()
        }
      }

      const statusText = sent ? tr('terminal.sent') : busy ? tr('terminal.running') : tr('terminal.idle')
      const tone = sent ? 'sent' : busy ? 'running' : 'idle'

      return h(
        'div',
        { className: 'dsc-term', 'data-terminal': sessionId },
        h(
          'div',
          { className: 'dsc-term-head' },
          h('span', { className: 'dsc-term-title' }, tr('terminal.title')),
          h('span', { className: 'dsc-term-cwd', title: cwd }, tr('terminal.cwd', { path: cwd.length > 0 ? cwd : '…' })),
          h('span', { className: 'dsc-term-status', 'data-tone': tone }, statusText),
          h('button', { type: 'button', className: 'dsc-btn', onClick: close }, tr('terminal.close')),
        ),
        h(
          'pre',
          {
            className: lines.length === 0 ? 'dsc-term-body dsc-term-body-empty' : 'dsc-term-body',
            ref: bodyRef,
            'aria-label': tr('terminal.title'),
          },
          loading ? tr('terminal.loading') : lines.length > 0 ? lines.join('\n') : tr('terminal.placeholder'),
        ),
        error !== null ? h('div', { className: 'dsc-term-error', role: 'alert' }, error) : null,
        sent ? h('div', { className: 'dsc-term-note' }, tr('terminal.sent')) : null,
        h(
          'div',
          { className: 'dsc-term-foot' },
          h('span', { className: 'dsc-term-prompt', 'aria-hidden': 'true' }, '$'),
          h('input', {
            className: 'dsc-term-input',
            ref: inputRef,
            value,
            // 执行中保持可聚焦（用 readOnly 而不是 disabled），避免焦点被浏览器移走。
            readOnly: busy,
            disabled: sent,
            placeholder: tr('terminal.placeholder'),
            'aria-label': tr('terminal.placeholder'),
            'aria-busy': busy,
            autoComplete: 'off',
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown,
          }),
          h(
            'button',
            { type: 'button', className: 'dsc-btn', disabled: busy || sent, onClick: () => void finish() },
            tr('terminal.send'),
          ),
        ),
        h('div', { className: 'dsc-term-hint' }, tr('terminal.hint')),
      )
    }

    /**
     * `conversation.input.dock` 条目：终端打开时渲染面板。
     *
     * 触发有两条路径：
     * 1. commandview 看到裸 `/cmd` 的标记后调用 `setTerminalOpen`（快路径）；
     * 2. 这里轮询 Host 的 `status`，取走裸 `/cmd` 记录的打开请求（兜底：
     *    命令行卡片未渲染 / 组件未拿到 sessionId 时仍能打开）。
     *
     * @param {{ sessionId?: string, session?: { id?: string }, t?: Function }} props
     */
    function TerminalDock(props) {
      const sessionId =
        typeof props.sessionId === 'string' && props.sessionId.length > 0
          ? props.sessionId
          : typeof props.session?.id === 'string'
            ? props.session.id
            : ''
      const open = useTerminalOpen(sessionId)
      const fastUntilRef = React.useRef(0)
      const claimName = props.input?.claim?.name
      const phase = props.input?.phase

      // 刚提交过 /cmd 时快速轮询（180ms），其余时间低频兜底（1.2s）。
      React.useEffect(() => {
        if (claimName === 'cmd' || phase === 'submitting') fastUntilRef.current = Date.now() + 8000
      }, [claimName, phase])

      React.useEffect(() => {
        if (open || sessionId.length === 0) return undefined
        let cancelled = false
        let timer = 0
        const run = async () => {
          if (cancelled) return
          try {
            const status = await terminalRpc(sessionId, 'status')
            if (!cancelled && status !== null && status.pendingOpen === true) {
              setTerminalOpen(sessionId, true)
              return
            }
          } catch {
            /* 轮询失败静默；下一个周期重试 */
          }
          if (!cancelled) timer = window.setTimeout(run, Date.now() < fastUntilRef.current ? 180 : 1200)
        }
        timer = window.setTimeout(run, Date.now() < fastUntilRef.current ? 150 : 400)
        return () => {
          cancelled = true
          window.clearTimeout(timer)
        }
      }, [open, sessionId, claimName, phase])

      if (!open || sessionId.length === 0) return null
      return h(TerminalView, { sessionId, tr: makeTranslator(props.t) })
    }

    /**
     * 插件装配：一切注册都走 `ctx.effect`，卸载时全部撤销。
     * @param {any} ctx 插件根上下文（inject: slots / locale）
     */
    function apply(ctx) {
      try {
        const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined
        terminalHostRpc =
          connection !== undefined && connection !== null && typeof connection.rpc === 'function'
            ? connection.rpc.bind(connection)
            : null
      } catch {
        terminalHostRpc = null
      }
      ctx.effect(() => insertStyle(), 'dsh-shell-cmd: card styles')
      let translate = null
      try {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-shell-cmd: dictionaries')
        translate = ctx.locale.bind(NS)
      } catch {
        translate = null
      }
      /** 渲染入口：把翻译函数通过 props 传给卡片，自身保持稳定引用。 */
      const View = (props) => h(ShellCommandCard, translate === null ? props : { ...props, t: translate })
      View.displayName = 'DshShellCmdCard'
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.commandview',
            key: 'cmd',
          },
          View,
        ),
      )

      const HintView = (props) => h(ShellCmdHint, translate === null ? props : { ...props, t: translate })
      HintView.displayName = 'DshShellCmdHint'
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'shell-cmd-hint',
            order: 20,
          },
          HintView,
        ),
      )

      const TerminalEntry = (props) => h(TerminalDock, translate === null ? props : { ...props, t: translate })
      TerminalEntry.displayName = 'DshShellCmdTerminal'
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'shell-cmd-terminal',
            order: 10,
          },
          TerminalEntry,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
