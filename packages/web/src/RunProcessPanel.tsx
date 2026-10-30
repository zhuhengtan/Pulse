import { useEffect, useState } from 'react'
import { Drawer } from 'antd'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { PulseButton } from './PulseControls.js'

type Process = { processId: string; status: 'running' | 'exited' | 'unknown'; command: { command: string; args?: string[]; pty?: boolean }; result?: { code?: number | null }; stdinReady?: boolean; inputUncertain?: boolean }
type Page = Process & { output: string; nextOffset: number; truncated: boolean; code?: number | null }
const label = (process: Process) => process.status === 'unknown' ? '状态未知，不会自动重启' : process.status === 'running' ? '运行中' : `已退出${process.result?.code == null ? '' : ` · ${process.result.code}`}`
// Render text only: terminal control sequences are not interpreted as HTML or links.
const plain = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

/** Read-only Agent process output. There is deliberately no keyboard/stdin channel. */
export function RunProcessPanel({ transport, runId, onClose }: { transport: PulseWebTransport; runId: string; onClose(): void }) {
  const base = `/api/runs/${encodeURIComponent(runId)}/processes`
  const [items, setItems] = useState<Process[]>([])
  const [selected, setSelected] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [stopping, setStopping] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const data = await apiJson<{ items: Process[] }>(transport, base, { signal: controller.signal })
        if (controller.signal.aborted) return
        setItems(data.items); setSelected(current => data.items.some(item => item.processId === current) ? current : data.items[0]?.processId ?? ''); setError('')
      } catch { if (!controller.signal.aborted) setError('无法读取任务进程，请检查后台连接。') }
      finally { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => void refresh(), 2000) } }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [transport, base, revision])
  useEffect(() => {
    setOutput('')
    if (!selected) return
    const controller = new AbortController(); let offset = 0, timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const page = await apiJson<Page>(transport, `${base}/${selected}?offset=${offset}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset < offset) throw new Error('INVALID_OUTPUT_CURSOR')
        offset = page.nextOffset
        setOutput(current => (current + plain(page.output)).slice(-65536))
        if (page.truncated || page.status === 'running') timer = setTimeout(() => void read(), page.truncated ? 50 : 2000)
      } catch { if (!controller.signal.aborted) setError('进程输出暂不可用，原进程不会自动重试或重启。') }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [transport, base, selected, revision])
  const current = items.find(item => item.processId === selected)
  const stop = async () => {
    if (stopping || current?.status !== 'running') return
    setStopping(true)
    try { await apiJson(transport, `${base}/${selected}/cancel`, jsonRequest('POST')); setRevision(value => value + 1) }
    catch { setError('未能确认停止结果，请刷新进程状态。') }
    finally { setStopping(false) }
  }
  return <Drawer title="任务进程" open onClose={onClose} size="large" styles={{ wrapper: { maxWidth: '100vw' } }}>
    <p className="setting-note">这里显示当前任务启动的进程和最近输出。交互输入由 Agent 单独申请审批；状态未知时不会重启进程。</p>
    {error && <div role="alert">{error} <PulseButton onClick={() => setRevision(value => value + 1)}>刷新</PulseButton></div>}
    {loading && <p role="status">正在读取进程…</p>}
    {!loading && !items.length && <p>此任务没有已记录的进程。</p>}
    <div className="run-process-list" role="list" aria-label="任务进程列表">{items.map(item => <div key={item.processId} role="listitem"><PulseButton aria-pressed={selected === item.processId} onClick={() => setSelected(item.processId)}><strong>{item.command.command}</strong>{item.command.pty ? ' · PTY' : ''}<span>{label(item)}</span></PulseButton></div>)}</div>
    {current && <section aria-label="进程详情"><p role="status">{label(current)}{current.inputUncertain ? ' · 输入送达状态未知，验收仍被阻止' : current.stdinReady ? ' · 可申请交互输入' : ''}</p>
      <PulseButton disabled={current.status !== 'running' || stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止进程'}</PulseButton>
      <pre className="run-process-output" aria-label="只读进程输出" tabIndex={0}>{output || '暂无输出'}</pre>
      <p className="setting-note">最多保留最近 64K 字符；完整日志保存在原任务记录中。</p>
    </section>}
  </Drawer>
}
