/**
 * dsh-shell-cmd · Client 半端（单文件自包含 classic script）
 *
 * 形态约束：
 * - 本文件是宿主 `window.__ModuleLoader__` 的懒工厂注册脚本，id 必须等于包名。
 * - 不能 import / require 任何相对文件或其它 Client 包；只能 `require('react')`。
 * - 无 JSX：全部 `React.createElement`。
 * - 样式通过 `<style data-plugin-css>` 注入，并在 `ctx.effect` 清理函数里移除。
 *
 * 职责：
 * 1. 把 `/cmd <cmd>` 命令记录（`CommandNode`）渲染成终端卡片；
 * 2. 裸 `/cmd` 打开交互终端模态（`conversation.input.overlay`）；
 * 3. 给 Host 的 `cmd` 命令挂 bare 调用装饰（`ctx.commandUi.decorate`），
 *    使「裸 /cmd + Enter」像 `/context` 一样消费 token 并直接打开模态。
 *
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
      'terminal.retry': 'Retry',
      'terminal.error.sessionNotFound': 'The session is not ready yet. Try again in a moment.',
      'terminal.error.busy': 'A command is still running. Wait for it to finish or interrupt it first.',
      'terminal.error.empty': 'Run at least one command before sending.',
      'terminal.error.unauthorized': 'Not authorized. Reload the page and try again.',
      'terminal.error.forbidden': 'The DSH host refused this request.',
      'terminal.error.badRequest': 'The DSH host rejected the terminal request as invalid.',
      'terminal.error.tooLarge': 'The request or its output is too large for the terminal.',
      'terminal.error.internal': 'The DSH host failed to handle the terminal request.',
      'terminal.error.network': 'Cannot reach the DSH host. Check the connection and try again.',
      'terminal.error.timeout': 'The DSH host did not answer in time. Try again.',
      'terminal.error.badResponse': 'The DSH host returned a response that could not be read.',
      'terminal.error.http': 'The DSH host answered with HTTP {status}.',
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
      'terminal.retry': '重试',
      'terminal.error.sessionNotFound': '会话尚未就绪，请稍后重试。',
      'terminal.error.busy': '命令仍在执行，请等待结束或先中断。',
      'terminal.error.empty': '至少执行一条命令后才能发送给模型。',
      'terminal.error.unauthorized': '没有权限，请刷新页面后重试。',
      'terminal.error.forbidden': 'DSH 主机拒绝了该请求。',
      'terminal.error.badRequest': 'DSH 主机判定终端请求无效。',
      'terminal.error.tooLarge': '请求或输出超出终端上限。',
      'terminal.error.internal': 'DSH 主机处理终端请求时出错。',
      'terminal.error.network': '无法连接 DSH 主机，请检查连接后重试。',
      'terminal.error.timeout': 'DSH 主机响应超时，请重试。',
      'terminal.error.badResponse': 'DSH 主机返回了无法解析的响应。',
      'terminal.error.http': 'DSH 主机返回 HTTP {status}。',
    }

    /** 卡片与交互终端样式；颜色一律走宿主主题令牌，明暗主题自动跟随。 */
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
.dsc-term-backdrop {
  box-sizing: border-box;
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45));
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}
.dsc-term-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  max-height: min(82vh, 720px);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px #0006);
  overflow: hidden;
  font-size: 12px;
}
.dsc-term {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
  font-size: 12px;
}
.dsc-term-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.dsc-term-title { flex: none; font-weight: 600; font-size: 12.5px; color: var(--dsw-alias-label-primary); }
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
  flex: 1 1 auto;
  min-height: 160px;
  height: 340px;
  margin: 0;
  padding: 10px 12px;
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
.dsc-term-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-state-error-primary);
  font-size: 11.5px;
}
.dsc-term-error-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dsc-term-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 4px;
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
.dsc-term-input[readonly] { color: var(--dsw-alias-label-secondary); }
.dsc-term-hint {
  padding: 0 12px 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.dsc-term-note { padding: 4px 12px; color: var(--dsw-alias-state-success-primary); font-size: 11.5px; }
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

      // 裸 /cmd 的 CommandResult 只用来打开交互终端：**任何**这种结果都不渲染卡片
      // （否则按 Esc 关闭终端后，对话记录里会留下一条奇怪的 cmd 卡片）。
      // 只有“刚发生”的结果才触发打开，避免回放历史时误开终端；同一个
      // commandId/seq 只打开一次（槽位重渲染/回放时不会重复打开）。
      const isTerminalResult =
        args.trim().length === 0 &&
        typeof outcome?.text === 'string' &&
        outcome.text.startsWith(TERMINAL_MARKER)
      const opensTerminal =
        isTerminalResult &&
        typeof node.time === 'number' &&
        Date.now() - node.time < TERMINAL_OPEN_FRESH_MS
      React.useEffect(() => {
        if (!opensTerminal) return
        const key = `${typeof node.commandId === 'string' ? node.commandId : ''}:${typeof node.seq === 'number' ? node.seq : ''}`
        if (key === ':' || openedTerminalMarkers.has(key)) return
        openedTerminalMarkers.add(key)
        if (openedTerminalMarkers.size > 64) {
          const oldest = openedTerminalMarkers.values().next().value
          openedTerminalMarkers.delete(oldest)
        }
        setTerminalOpen(props.sessionId, true)
      }, [opensTerminal, props.sessionId, node.seq, node.commandId])
      if (isTerminalResult) return null

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
    // 交互终端：打开状态（按 session）、RPC 客户端与模态面板
    // ------------------------------------------------------------------

    /**
     * 终端 RPC 的**页面相对**路径（与 terminal.js 的 TERMINAL_FETCH_PATH 对应）。
     *
     * 必须保持相对地址：Desktop 页面 origin 是 `dsh-app://app`，而
     * `__DSH_TRANSPORT__.streamBaseUrl` 是 `http://127.0.0.1:<port>`。用后者拼
     * 绝对地址会变成跨源请求（浏览器直接 TypeError: Failed to fetch）。
     * Web 与 Desktop 壳都会把非静态路径 forward 给 Host 并注入认证 cookie，
     * 所以这里只用 `api/...`（与 dsh-context 的 `api/dsh-context/…` 同款）。
     */
    const TERMINAL_RPC = 'api/cmd-terminal/rpc'

    /** 轻量 RPC（open/status/close/cancel/finish）超时：失败尽快暴露，不要无限转圈。 */
    const TERMINAL_RPC_TIMEOUT_MS = 15000

    /**
     * `send` 会在同一个 HTTP 请求里真正执行命令，Host 侧单条命令的默认超时是
     * 120s，所以等待时间必须覆盖它，否则长命令会被前端 15s 超时截断。
     */
    const TERMINAL_SEND_TIMEOUT_MS = 130000

    /** 裸 /cmd 的打开标记（与 terminal.js 的 OPEN_MARKER 一致）。 */
    const TERMINAL_MARKER = '[[dsh-shell-cmd:terminal]]'
    /** 只对“刚发生”的命令行打开终端，避免回放历史时误触发。 */
    const TERMINAL_OPEN_FRESH_MS = 15000

    /** 已消费过的裸 /cmd 标记（`commandId:seq`），避免同一条记录重复打开。 */
    const openedTerminalMarkers = new Set()

    /** Host 错误码 → 本地化文案 key。 */
    const TERMINAL_ERROR_TEXT = Object.freeze({
      'session-not-found': 'terminal.error.sessionNotFound',
      busy: 'terminal.error.busy',
      empty: 'terminal.error.empty',
      unauthorized: 'terminal.error.unauthorized',
      forbidden: 'terminal.error.forbidden',
      'bad-request': 'terminal.error.badRequest',
      'too-large': 'terminal.error.tooLarge',
      internal: 'terminal.error.internal',
      network: 'terminal.error.network',
      timeout: 'terminal.error.timeout',
      'bad-response': 'terminal.error.badResponse',
      http: 'terminal.error.http',
    })

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

    /** 构造带 `code` 的终端错误（供 UI 按 code 本地化）。 */
    function terminalError(code, message) {
      const error = new Error(typeof message === 'string' && message.length > 0 ? message : code)
      error.code = code
      return error
    }

    /** 错误 → 本地化文案：已知 code 走字典，未知 code 退回原始 message。 */
    function terminalErrorMessage(tr, cause) {
      const code = cause !== null && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : ''
      const key = Object.prototype.hasOwnProperty.call(TERMINAL_ERROR_TEXT, code) ? TERMINAL_ERROR_TEXT[code] : ''
      if (key !== '') {
        if (key === 'terminal.error.http') return tr(key, { status: cause.status ?? '' })
        return tr(key)
      }
      return cause instanceof Error ? cause.message : String(cause)
    }

    /**
     * 调用 Host 的终端 RPC（相对页面地址的同源请求）。
     * @param {string} sessionId 会话 id
     * @param {string} method open | read | status | send | cancel | finish | close
     * @param {object} [params] 额外参数
     * @param {{ timeoutMs?: number }} [options] 超时覆盖（send 用更长的执行超时）
     * @returns {Promise<any>}
     */
    async function terminalRpc(sessionId, method, params, options) {
      const timeoutMs =
        options !== null && typeof options === 'object' && Number.isFinite(options.timeoutMs)
          ? options.timeoutMs
          : TERMINAL_RPC_TIMEOUT_MS
      const payload = { method, params: { sessionId, ...(params ?? {}) } }
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
      let response
      try {
        response = await fetch(TERMINAL_RPC, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (cause) {
        const name = cause !== null && typeof cause === 'object' && typeof cause.name === 'string' ? cause.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') throw terminalError('timeout', 'terminal request timed out')
        throw terminalError('network', cause instanceof Error ? cause.message : String(cause))
      }
      let json = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      if (json === null || typeof json !== 'object') {
        const error = terminalError(response.ok ? 'bad-response' : 'http', `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      if (json.ok !== true) {
        const detail = json.error !== null && typeof json.error === 'object' ? json.error : {}
        throw terminalError(typeof detail.code === 'string' ? detail.code : 'internal', typeof detail.message === 'string' ? detail.message : '')
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
     * 交互终端面板内容：输出滚动区 + 单行输入 + 快捷键。
     * Enter 执行、Ctrl+C 中断、Ctrl+Enter 发送给模型、Esc 关闭。
     * @param {{ sessionId: string, tr: Function, onClose: Function }} props
     */
    function TerminalView(props) {
      const { sessionId, tr, onClose } = props
      const [lines, setLines] = React.useState([])
      const [cwd, setCwd] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [sent, setSent] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [value, setValue] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [reloadKey, setReloadKey] = React.useState(0)
      const bodyRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const retryRef = React.useRef(null)
      // tr 每次渲染可能是新函数；用 ref 固定，避免把它塞进 effect 依赖导致重复 open。
      const trRef = React.useRef(tr)
      trRef.current = tr

      const applySnapshot = (snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object') return
        if (Array.isArray(snapshot.lines)) setLines(snapshot.lines)
        if (typeof snapshot.cwd === 'string' && snapshot.cwd.length > 0) setCwd(snapshot.cwd)
        if (snapshot.sent === true) setSent(true)
      }

      const fail = (cause, retry) => {
        retryRef.current = typeof retry === 'function' ? retry : null
        setError(terminalErrorMessage(trRef.current, cause))
      }

      React.useEffect(() => {
        let cancelled = false
        setLoading(true)
        retryRef.current = null
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
            fail(cause, () => setReloadKey((key) => key + 1))
            setLoading(false)
          },
        )
        return () => {
          cancelled = true
        }
        // applySnapshot / fail 只调用 setState；随渲染变化但无需作为依赖。
      }, [sessionId, reloadKey])

      React.useEffect(() => {
        const element = bodyRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [lines, busy, loading])

      React.useEffect(() => {
        // 打开完成 / 命令执行结束（busy 变 false）后把焦点还给输入行。
        if (!loading && !sent && !busy) inputRef.current?.focus()
      }, [loading, sent, busy])

      const send = async (rawText) => {
        if (busy || sent) return
        const text = typeof rawText === 'string' ? rawText : value
        if (text.trim().length === 0) return
        setBusy(true)
        retryRef.current = null
        setError(null)
        try {
          applySnapshot(await terminalRpc(sessionId, 'send', { text }, { timeoutMs: TERMINAL_SEND_TIMEOUT_MS }))
          setValue('')
        } catch (cause) {
          fail(cause, () => {
            void send(text)
          })
        } finally {
          setBusy(false)
        }
      }

      const finish = async () => {
        if (busy) {
          fail(terminalError('busy'), null)
          return
        }
        if (sent) return
        const hasCommand = lines.some((line) => typeof line === 'string' && line.startsWith('$ '))
        if (!hasCommand) {
          fail(terminalError('empty'), null)
          return
        }
        retryRef.current = null
        setError(null)
        try {
          applySnapshot(await terminalRpc(sessionId, 'finish'))
          setSent(true)
          // Ctrl+Enter 发送成功后终端模态直接消失，把位置还给输入框。
          onClose()
        } catch (cause) {
          fail(cause, () => {
            void finish()
          })
        }
      }

      const interrupt = () => {
        if (busy) {
          terminalRpc(sessionId, 'cancel').catch(() => {})
          return
        }
        setValue('')
      }

      const retry = () => {
        const action = retryRef.current
        retryRef.current = null
        setError(null)
        if (typeof action === 'function') action()
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
          onClose()
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          void send(value)
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
          h('button', { type: 'button', className: 'dsc-btn', onClick: onClose }, tr('terminal.close')),
        ),
        h(
          'pre',
          {
            className: lines.length === 0 ? 'dsc-term-body dsc-term-body-empty' : 'dsc-term-body',
            ref: bodyRef,
            'aria-label': tr('terminal.title'),
            'aria-busy': busy,
          },
          loading ? tr('terminal.loading') : lines.length > 0 ? lines.join('\n') : tr('terminal.placeholder'),
        ),
        error !== null
          ? h(
              'div',
              { className: 'dsc-term-error', role: 'alert' },
              h('span', { className: 'dsc-term-error-text' }, error),
              retryRef.current !== null
                ? h('button', { type: 'button', className: 'dsc-btn', onClick: retry }, tr('terminal.retry'))
                : null,
            )
          : null,
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
            readOnly: busy || sent,
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
     * `conversation.input.overlay` 条目：`/context` 式模态。
     *
     * 打开触发：
     * 1. 主路径：`ctx.commandUi.decorate` 给 Host 命令 `cmd` 挂的 bare action
     *    直接 `setTerminalOpen(sessionId, true)`（token 已被消费，草稿清空）；
     * 2. 兜底 1：commandview 看到裸 `/cmd` 的 OPEN_MARKER（按 commandId/seq 去重）；
     * 3. 兜底 2：面板关闭时低频轮询 Host `status` 的 `pendingOpen`。
     *
     * 关闭：best-effort RPC close（失败忽略）→ 收起模态 → 防御性清理残留的 `/cmd` 草稿。
     *
     * @param {{ sessionId?: string, useInput?: Function, inputActions?: object, t?: Function }} props
     */
    function TerminalOverlay(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const open = useTerminalOpen(sessionId)
      const useInput = typeof props.useInput === 'function' ? props.useInput : null
      const inputActions = props.inputActions
      const phase = useInput === null ? '' : useInput((state) => (typeof state?.phase === 'string' ? state.phase : ''))
      const draft = useInput === null ? '' : useInput((state) => (typeof state?.draft === 'string' ? state.draft : ''))
      const fastUntilRef = React.useRef(0)
      // 同一 Esc 可能同时被 document 捕获监听和输入框 onKeyDown 触达；80ms 内幂等去重，
      // 避免重复 close RPC / 重复 setDraft。
      const closeGuardRef = React.useRef(0)
      const draftRef = React.useRef(draft)
      draftRef.current = draft

      // 刚提交过 /cmd 时快速轮询（180ms），其余时间低频兜底（1.2s）。
      React.useEffect(() => {
        if (phase === 'submitting' || phase === 'claimed') fastUntilRef.current = Date.now() + 8000
      }, [phase])

      const close = React.useCallback(() => {
        if (sessionId.length === 0) return
        const now = Date.now()
        if (now - closeGuardRef.current < 80) return
        closeGuardRef.current = now
        // best-effort：Host 侧 close 失败（例如状态已随 finish 删除）不影响收起模态。
        terminalRpc(sessionId, 'close').catch(() => {})
        setTerminalOpen(sessionId, false)
        // 防御：正常 action 路径下 token 已被消费、草稿为空；旧 Host / 旧路径可能残留 `/cmd`。
        if (draftRef.current.trim() !== '/cmd') return
        if (inputActions === null || typeof inputActions !== 'object') return
        if (typeof inputActions.setDraft !== 'function') return
        try {
          inputActions.setDraft('')
        } catch {
          /* 草稿清理失败不影响关闭 */
        }
      }, [sessionId, inputActions])

      // Esc 关闭：document 捕获阶段监听，确保焦点在终端输入框还是别处都能关掉。
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.isComposing === true) return
          event.preventDefault()
          event.stopPropagation()
          close()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [open, close])

      // 轮询兜底：只在面板关闭时跑，取走 Host 记录的 pendingOpen（不消费请求）。
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
      }, [open, sessionId])

      if (!open || sessionId.length === 0) return null
      const tr = makeTranslator(props.t)
      return h(
        'div',
        {
          className: 'dsc-term-backdrop',
          'data-shell-cmd-terminal': 'overlay',
          // 点遮罩关闭；卡片内点击 stopPropagation，不会误关。
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          {
            className: 'dsc-term-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tr('terminal.title'),
            onMouseDown: (event) => event.stopPropagation(),
          },
          h(TerminalView, { sessionId, tr, onClose: close }),
        ),
      )
    }

    /**
     * 插件装配：一切注册都走 `ctx.effect`，卸载时全部撤销。
     * @param {any} ctx 插件根上下文（inject: slots / locale）
     */
    function apply(ctx) {
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

      // 裸 /cmd 打开交互终端：给 Host 命令 `cmd` 挂 bare 调用装饰（与 /context 同款）。
      // 触发时 commands 客户端会先消费掉 `/cmd` token（草稿清空、不提交消息），
      // 再执行 run —— 这就是「面板提前打开 / Esc 后又被 claim 重开」的正确修法。
      ctx.inject(['commandUi'], (scope) => {
        scope.effect(
          () =>
            scope.commandUi.decorate({
              name: 'cmd',
              available: () => true,
              ui: {
                kind: 'action',
                run: (session) => {
                  const id = typeof session?.sessionId === 'string' ? session.sessionId : ''
                  if (id.length > 0) setTerminalOpen(id, true)
                },
              },
            }),
          'dsh-shell-cmd: /cmd bare action',
        )
      })

      const TerminalEntry = (props) => h(TerminalOverlay, translate === null ? props : { ...props, t: translate })
      TerminalEntry.displayName = 'DshShellCmdTerminal'
      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'shell-cmd-terminal',
            order: 20,
            inject: (sessionId) => ({ sessionId }),
          },
          TerminalEntry,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
