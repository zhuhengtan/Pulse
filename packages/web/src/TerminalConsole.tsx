import { createPulseSocket } from './transport.js'
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { PulseWebTransport } from './transport.js'

export function TerminalConsole({ terminalId, transport, active }: { terminalId: string; transport: PulseWebTransport; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [state, setState] = useState('正在连接…')

  useEffect(() => {
    const element = host.current
    if (!element) return
    const terminal = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, scrollback: 5000, theme: { background: '#101723', foreground: '#e6edf6', cursor: '#6d8fff', selectionBackground: '#3157a5' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    let disposed = false
    let shouldStop = false
    let socket: WebSocket | undefined
    let retryTimer: number | undefined
    let retries = 0
    let received = ''

    const scheduleFit = () => {
      if (!activeRef.current || disposed) return
      requestAnimationFrame(() => {
        try { fit.fit(); socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })) } catch { /* terminal can be hidden while the panel resizes */ }
      })
    }
    const connect = () => {
      if (disposed || shouldStop) return
      setState(retries ? '正在重新连接…' : '正在连接…')
      socket = createPulseSocket(`/api/terminals/${encodeURIComponent(terminalId)}/socket`)
      socket.onopen = () => { retries = 0; setState('已连接'); scheduleFit() }
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; data?: string; code?: number; signal?: number; exit?: { code: number; signal?: number } }
          if (message.type === 'snapshot') {
            const snapshot = message.data ?? ''
            if (!received) terminal.write(snapshot)
            else if (snapshot.startsWith(received)) terminal.write(snapshot.slice(received.length))
            else if (!snapshot.endsWith(received)) terminal.write(`\r\n[终端已重连，以下为当前输出快照]\r\n${snapshot}`)
            received = snapshot.slice(-512 * 1024)
            const exitCode = message.exit?.code ?? message.code
            if (exitCode !== undefined) { terminal.write(`\r\n[进程已退出，代码 ${exitCode}]\r\n`); setState('进程已退出') }
          } else if (message.type === 'output' && typeof message.data === 'string') {
            terminal.write(message.data); received = `${received}${message.data}`.slice(-512 * 1024)
          } else if (message.type === 'exit') { terminal.write(`\r\n[进程已退出，代码 ${message.code ?? '未知'}]\r\n`); setState('进程已退出') }
        } catch { terminal.write('\r\n[收到无法识别的终端数据]\r\n') }
      }
      socket.onerror = () => setState('连接异常')
      socket.onclose = () => {
        if (disposed || shouldStop) return
        setState('连接中断，准备重连…')
        retries++
        retryTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(retries, 5)))
      }
    }

    const input = terminal.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })) })
    const resize = new ResizeObserver(scheduleFit)
    resize.observe(element)
    connect()
    const readyFit = window.setTimeout(scheduleFit, 80)
    return () => {
      disposed = true; shouldStop = true; window.clearTimeout(readyFit)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      resize.disconnect(); input.dispose()
      socket?.close(1000, 'Terminal panel changed')
      terminal.dispose()
    }
  }, [terminalId])

  useEffect(() => { if (active) window.dispatchEvent(new Event('resize')) }, [active])
  return <div className="terminal-console-wrap"><div className="terminal-status">{state}</div><div className="terminal-console" ref={host} aria-label="本机交互终端" /></div>
}
