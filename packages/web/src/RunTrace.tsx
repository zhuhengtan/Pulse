import { Icon } from './Icon.js'
import type { ComponentProps } from 'react'
import { PulseButton } from './PulseControls.js'
import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { apiJson, type PulseWebTransport, type WebLane, type WebRunEvent } from './transport.js'

export interface TraceStep {
  id: string
  kind: 'llm' | 'tool'
  effectId?: string
  attemptId?: string
  attemptNo?: number
  // llm
  task?: string
  modelId?: string
  fallback?: boolean
  reasoning?: string
  note?: string
  // tool
  tool?: string
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled'
  args?: Record<string, unknown>
  preview?: Record<string, unknown>
  error?: Record<string, unknown>
}

export interface TraceLane {
  id: string
  parentId?: string
  label: string
  goal?: string
  status: WebLane['status']
  steps: TraceStep[]
}

export interface TraceState {
  lanes: Record<string, TraceLane>
  order: string[]
  label?: string
  outcome?: 'succeeded' | 'failed' | 'cancelled'
  startedAt?: number
  endedAt?: number
}

export const emptyTrace: TraceState = { lanes: {}, order: [] }

const MAIN_LANE = '__main__'
const TRACE_TEXT_LIMIT = 24_000

function appendTraceText(prior: string | undefined, text: string): string {
  const base = prior ?? ''
  if (base.length >= TRACE_TEXT_LIMIT) return base
  return `${base}${text}`.slice(0, TRACE_TEXT_LIMIT)
}

function ensureLane(state: TraceState, id: string | undefined): [TraceState, TraceLane] {
  const laneId = id ?? state.order[0] ?? MAIN_LANE
  const existing = state.lanes[laneId]
  if (existing) return [state, existing]
  const lane: TraceLane = { id: laneId, label: laneId === MAIN_LANE ? '主任务' : '执行任务', status: 'running', steps: [] }
  return [{ ...state, lanes: { ...state.lanes, [laneId]: lane }, order: [...state.order, laneId] }, lane]
}

function putStep(state: TraceState, laneId: string | undefined, step: TraceStep): TraceState {
  const [next, lane] = ensureLane(state, laneId)
  const index = lane.steps.findIndex(item => item.id === step.id)
  const steps = index < 0 ? [...lane.steps, step] : lane.steps.map((item, i) => i === index ? { ...item, ...step } : item)
  return { ...next, lanes: { ...next.lanes, [lane.id]: { ...lane, steps } } }
}

function findLaneOfEffect(state: TraceState, effectId: string | undefined): string | undefined {
  if (!effectId) return undefined
  return state.order.find(id => state.lanes[id]?.steps.some(step => step.effectId === effectId || step.id === effectId))
}

/** Folds the browser-safe run events into a lane-oriented execution trace. */
export function reduceTrace(state: TraceState, event: WebRunEvent): TraceState {
  const startedAt = event.runStartedAt ?? event.timestamp
  const base = startedAt !== undefined && Number.isFinite(startedAt) ? { ...state, startedAt: Math.min(state.startedAt ?? startedAt, startedAt) } : state
  if (event.type === 'status') return event.data.label ? { ...base, label: event.data.label } : base
  if (event.type === 'lanes') {
    const lanes = { ...base.lanes }
    const order = [...base.order]
    for (const lane of event.data.lanes) {
      const prior = lanes[lane.id] ?? (lanes[MAIN_LANE] && !lane.parentId && order[0] === MAIN_LANE ? lanes[MAIN_LANE] : undefined)
      if (!lanes[lane.id]) { if (prior && prior.id === MAIN_LANE) { delete lanes[MAIN_LANE]; order[order.indexOf(MAIN_LANE)] = lane.id } else order.push(lane.id) }
      lanes[lane.id] = { steps: prior?.steps ?? [], id: lane.id, ...(lane.parentId ? { parentId: lane.parentId } : {}), label: lane.label, ...(lane.goal ? { goal: lane.goal } : {}), status: lane.status }
    }
    return { ...base, lanes, order }
  }
  if (event.type === 'trace') {
    const data = event.data
    const laneId = data.laneId ?? findLaneOfEffect(base, data.effectId)
    const [next, lane] = ensureLane(base, laneId)
    // Older traces lack attemptId on prose; attach them to the matching model's
    // latest attempt without mixing newly identified attempts.
    const related = [...lane.steps].reverse().find(step => step.kind === 'llm' && step.effectId === data.effectId && (data.attemptId !== undefined ? step.attemptId === data.attemptId : data.attemptNo !== undefined ? step.attemptNo === data.attemptNo : !data.modelId || step.modelId === data.modelId))
    const attemptId = data.attemptId ?? related?.attemptId
    const attemptNo = data.attemptNo ?? related?.attemptNo ?? 1
    const id = JSON.stringify([data.effectId ?? event.seq, attemptId ?? attemptNo])
    const prior = lane.steps.find(step => step.id === id)
    const identity = { id, kind: 'llm' as const, ...(data.effectId ? { effectId: data.effectId } : {}), ...(attemptId ? { attemptId } : {}), attemptNo, task: data.task }
    if (data.kind === 'model') return putStep(next, lane.id, { ...identity, modelId: data.modelId, fallback: data.fallback })
    if (data.kind === 'reasoning') return putStep(next, lane.id, { ...identity, ...(data.modelId ? { modelId: data.modelId } : {}), reasoning: appendTraceText(prior?.reasoning, data.text) })
    return putStep(next, lane.id, { ...identity, note: appendTraceText(prior?.note, data.text) })
  }
  if (event.type === 'tool') {
    const d = event.data
    return putStep(base, d.laneId ?? findLaneOfEffect(base, d.effectId), { id: d.activityId, effectId: d.effectId, kind: 'tool', tool: d.tool, status: d.status, ...(d.args ? { args: d.args } : {}), ...(d.preview ? { preview: d.preview } : {}), ...(d.error ? { error: d.error } : {}) })
  }
  if (event.type === 'complete') return { ...base, outcome: event.data.status, ...(event.timestamp === undefined ? {} : { endedAt: event.timestamp }) }
  if (event.type === 'error') return { ...base, outcome: 'failed', ...(event.timestamp === undefined ? {} : { endedAt: event.timestamp }) }
  return base
}

export function isTraceEvent(event: WebRunEvent): boolean {
  return event.type === 'status' || event.type === 'lanes' || event.type === 'trace' || event.type === 'tool' || event.type === 'complete' || event.type === 'error'
}

const TASK_LABEL: Record<string, string> = { plan: '规划', reason: '推理', verify: '验证', merge: '汇总', vision: '识图' }

function str(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function shorten(value: string, max = 80): string { const one = value.replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max)}…` : one }

/** One-line, human-readable description of a tool call. */
export function summarizeTool(step: TraceStep): { icon: ComponentProps<typeof Icon>['name']; text: string } {
  const tool = step.tool ?? 'tool'
  const args = step.args ?? {}
  const preview = step.preview ?? {}
  const target = str(args.path) ?? str(args.file) ?? str(args.target)
  const matched = typeof preview.matched === 'number' ? ` · ${preview.matched} 处命中` : ''
  if (tool === 'fs.read') return { icon: 'file', text: `读取 ${target ?? ''}${typeof preview.lines === 'number' ? ` · ${preview.lines} 行` : ''}`.trim() }
  if (tool === 'fs.list') return { icon: 'folder', text: `列出 ${target ?? '目录'}${matched}` }
  if (tool === 'fs.search') return { icon: 'search', text: `搜索 “${shorten(str(args.pattern) ?? str(args.query) ?? '', 40)}”${matched}` }
  if (tool.startsWith('fs.') || tool === 'plan.write') return { icon: 'edit', text: `${tool === 'fs.move' ? '移动' : '修改'} ${target ?? ''}`.trim() }
  if (tool === 'shell.exec') {
    const command = [str(args.command), ...(Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === 'string') : [])].filter(Boolean).join(' ')
    return { icon: 'terminal', text: `执行 ${shorten(command, 70)}${preview.exitCode !== undefined && preview.exitCode !== null ? ` (退出码 ${String(preview.exitCode)})` : ''}` }
  }
  if (tool === 'web.search') return { icon: 'web', text: `搜索网页 “${shorten(str(args.query) ?? '', 40)}”${matched}` }
  if (tool === 'web.fetch') return { icon: 'web', text: `读取网页 ${shorten(str(args.url) ?? '', 60)}` }
  return { icon: 'tool', text: tool }
}

function DiffText({ text }: { text: string }) {
  return <pre className="trace-code">{text.split('\n').slice(0, 200).map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : undefined}>{line}{'\n'}</span>)}</pre>
}

function ToolDetail({ step }: { step: TraceStep }) {
  const patch = str(step.args?.patch) ?? str(step.args?.diff)
  const output = str(step.preview?.output)
  const locations = Array.isArray(step.preview?.locations) ? step.preview!.locations.filter((l): l is string => typeof l === 'string') : []
  const entries = Object.entries(step.args ?? {}).filter(([key, value]) => key !== 'patch' && key !== 'diff' && value !== undefined)
  return <div className="trace-detail">
    {step.error && <pre className="trace-code trace-error">{JSON.stringify(step.error, null, 2).slice(0, 4000)}</pre>}
    {patch && <DiffText text={patch} />}
    {output && <pre className="trace-code">{output}{step.preview?.truncated === true ? '\n…（已截断）' : ''}</pre>}
    {locations.length > 0 && <ul className="trace-locations">{locations.map(location => <li key={location}>{location}</li>)}</ul>}
    {entries.length > 0 && <pre className="trace-code trace-args">{JSON.stringify(Object.fromEntries(entries), null, 2).slice(0, 4000)}</pre>}
  </div>
}

function StepRow({ step, live }: { step: TraceStep; live: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const seenLive = useRef(false)
  if (live) seenLive.current = true
  if (step.kind === 'tool') {
    const { icon, text } = summarizeTool(step)
    const hasDetail = Boolean(step.error || step.args || step.preview)
    const open = userOpen ?? step.status === 'failed'
    return <div className={`trace-step trace-tool trace-${step.status ?? 'running'}`}>
      <PulseButton type="button" className="trace-row" onClick={() => setUserOpen(!open)} aria-expanded={open} disabled={!hasDetail}>
        <span className="trace-state">{step.status === 'running' ? <i className="trace-spin" /> : step.status === 'succeeded' ? '✓' : step.status === 'failed' ? '✕' : '–'}</span>
        <span className="trace-icon"><Icon name={icon} size={14}/></span><span className="trace-text">{text}</span>
        {hasDetail && <span className="trace-caret">{open ? '▾' : '▸'}</span>}
      </PulseButton>
      {open && hasDetail && <ToolDetail step={step} />}
    </div>
  }
  const body = [step.reasoning, step.note].filter(Boolean).join('\n\n')
  const open = userOpen ?? (live || seenLive.current)
  const task = TASK_LABEL[step.task ?? ''] ?? step.task ?? '推理'
  return <div className="trace-step trace-llm">
    <PulseButton type="button" className="trace-row" onClick={() => setUserOpen(!open)} aria-expanded={open} disabled={!body}>
      <span className="trace-state">{live ? <i className="trace-spin" /> : '◆'}</span>
      <span className="trace-text">{live ? '思考中' : '思考'} · {task}</span>
      {step.modelId && <span className={`trace-model ${step.fallback ? 'is-fallback' : ''}`} title={step.fallback ? '已回退到备用模型' : undefined}>{step.modelId}{step.fallback ? ' · 回退' : ''}</span>}
      {body && <span className="trace-caret">{open ? '▾' : '▸'}</span>}
    </PulseButton>
    {open && body && <div className="trace-thought">{body}</div>}
  </div>
}

function modelBadge(lane: TraceLane): { label: string; fallback: boolean } | undefined {
  const used = [...new Set(lane.steps.flatMap(step => step.kind === 'llm' && step.modelId ? [step.modelId] : []))]
  if (used.length === 0) return undefined
  const current = [...lane.steps].reverse().find(step => step.kind === 'llm' && step.modelId)?.modelId ?? used[0]!
  return { label: used.length > 1 ? `${current} (+${used.length - 1})` : current, fallback: lane.steps.some(step => step.fallback) }
}

const LANE_STATUS: Record<string, string> = { ready: '待命', running: '运行中', waiting: '等待中', closing: '收尾中', cancelling: '停止中', succeeded: '完成', failed: '失败', cancelled: '已停止' }

function LaneCard({ lane, depth, runActive }: { lane: TraceLane; depth: number; runActive: boolean }) {
  const active = runActive && (lane.status === 'running' || lane.status === 'waiting' || lane.status === 'ready')
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const open = userOpen ?? (active || depth === 0)
  const badge = modelBadge(lane)
  const tools = lane.steps.filter(step => step.kind === 'tool').length
  const lastIndex = lane.steps.length - 1
  return <section className={`trace-lane trace-lane-${lane.status}`} style={{ marginLeft: depth * 14 }}>
    <PulseButton type="button" className="trace-lane-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
      <span className={`trace-dot dot-${lane.status}`} />
      <span className="trace-lane-title"><strong>{lane.label}</strong>{lane.goal && <small>{shorten(lane.goal, 90)}</small>}</span>
      {badge && <span className={`trace-model ${badge.fallback ? 'is-fallback' : ''}`}>{badge.label}</span>}
      <small className="trace-lane-meta">{LANE_STATUS[lane.status] ?? lane.status}{tools ? ` · ${tools} 工具` : ''}</small>
      <span className="trace-caret">{open ? '▾' : '▸'}</span>
    </PulseButton>
    {open && <div className="trace-lane-body">
      {lane.steps.length === 0 && <p className="trace-empty">等待执行…</p>}
      {lane.steps.map((step, index) => <StepRow key={step.id} step={step} live={active && index === lastIndex && step.kind === 'llm'} />)}
    </div>}
  </section>
}

function laneDepth(state: TraceState, lane: TraceLane): number {
  let depth = 0
  let parent = lane.parentId
  while (parent && state.lanes[parent] && depth < 6) { depth++; parent = state.lanes[parent]!.parentId }
  return depth
}

function summary(state: TraceState, running: boolean): string {
  const lanes = state.order.length
  const tools = state.order.reduce((sum, id) => sum + (state.lanes[id]?.steps.filter(step => step.kind === 'tool').length ?? 0), 0)
  const head = running ? (state.label ?? '执行中') : state.outcome === 'succeeded' ? '已完成' : state.outcome === 'cancelled' ? '已停止' : state.outcome === 'failed' ? '未完成' : '已结束'
  const seconds = state.startedAt !== undefined && state.endedAt !== undefined ? Math.max(1, Math.round((state.endedAt - state.startedAt) / 1000)) : undefined
  return `${head} · ${lanes} 个 Lane · ${tools} 次工具调用${seconds ? ` · 耗时 ${seconds}s` : ''}`
}

/** Public work updates and observed results remain visible outside technical details. */
function RunProgress({ trace }: { trace: TraceState }) {
  const steps = trace.order.flatMap(id => trace.lanes[id]?.steps ?? [])
  const visible = steps.filter(step => step.note?.trim() || step.kind === 'tool')
  if (!visible.length) return null
  return <div className="run-progress" role="log" aria-label="工作进展" aria-live="polite" aria-relevant="additions text">
    {visible.map(step => step.kind === 'tool' ? <div className={`progress-result progress-${step.status ?? 'running'}`} key={step.id}>
      <span className="progress-result-state">{step.status === 'running' ? '进行中' : step.status === 'succeeded' ? '已完成' : step.status === 'failed' ? '失败' : '已停止'}</span>
      <span>{summarizeTool(step).text}</span>
      {typeof step.preview?.output === 'string' && <pre>{step.preview.output}</pre>}
      {step.error && <p>{String(step.error.message ?? step.error.code ?? '操作失败')}</p>}
    </div> : <p className="progress-note" key={step.id}>{step.note}</p>)}
  </div>
}

/** Collapsible main-process header plus nested lane cards. */
export function RunTraceView({ trace, running: streamRunning }: { trace: TraceState; running: boolean }) {
  const running = streamRunning && !trace.outcome
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const [wasRunning, setWasRunning] = useState(running)
  // Reset overrides at lifecycle transitions. Late replay events must not undo
  // the user's choice to reopen a completed run.
  if (wasRunning !== running) { setWasRunning(running); setUserOpen(undefined) }
  const open = wasRunning !== running ? running : userOpen ?? running
  const roots = trace.order.filter(id => { const lane = trace.lanes[id]!; return !lane.parentId || !trace.lanes[lane.parentId] })
  const render = (id: string): ReactElement[] => {
    const lane = trace.lanes[id]!
    const children = trace.order.filter(childId => trace.lanes[childId]?.parentId === id)
    return [<LaneCard key={id} lane={lane} depth={laneDepth(trace, lane)} runActive={running} />, ...children.flatMap(render)]
  }
  return <div className={`run-trace ${running ? 'is-running' : ''} outcome-${trace.outcome ?? 'running'}`}>
    <RunProgress trace={trace} />
    <PulseButton type="button" className="run-trace-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
      <span className={`trace-dot ${running ? 'dot-running' : trace.outcome === 'succeeded' ? 'dot-succeeded' : 'dot-failed'}`} />
      <strong>主进程</strong><span className="run-trace-summary">{summary(trace, running)}</span>
      <span className="trace-caret">{open ? '▾' : '▸'}</span>
    </PulseButton>
    {open && <div className="run-trace-body" role="region" aria-label="执行过程" tabIndex={0}>
      {trace.order.length === 0 && <p className="trace-empty">{trace.label ?? '正在准备…'}</p>}
      {roots.flatMap(render)}
    </div>}
  </div>
}

/** Loads the persisted trace of a finished run and shows it collapsed. */
export function PersistedRunTrace({ runId, transport }: { runId: string; transport: PulseWebTransport }) {
  const [trace, setTrace] = useState<TraceState | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    apiJson<{ events: WebRunEvent[] }>(transport, `/api/runs/${encodeURIComponent(runId)}/trace`)
      .then(result => { if (!cancelled) setTrace(result.events.reduce(reduceTrace, emptyTrace)) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [runId, transport])
  if (!trace || trace.order.length === 0) return null
  return <RunTraceView trace={trace} running={false} />
}
