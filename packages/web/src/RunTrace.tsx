import { presentRun, shellProcessPending, completeRunHealth, type RunCompletion } from '@hunterzhu/pulse-server/run-presentation'
import { admissionLabel } from './run-status.js'
import { Icon } from './Icon.js'
import { Markdown } from './Markdown.js'
import type { ComponentProps } from 'react'
import { PulseButton } from './PulseControls.js'
import type { ReactElement } from 'react'
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { apiJson, type PulseWebTransport, type WebLane, type WebRunAdmission, type WebRunEvent } from './transport.js'

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
  health?: import('@hunterzhu/pulse-server/run-presentation').RunHealth
  completion?: RunCompletion
  outcome?: 'succeeded' | 'failed' | 'cancelled'
  admission?: WebRunAdmission
  startedAt?: number
  endedAt?: number
  errorMessage?: string
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
  const admission = event.type === 'status' ? event.data.admission ?? state.admission : state.admission
  // Admission timestamps are authoritative: runStartedAt may still be the enqueue time.
  const startedAt = admission ? admission.startedAt : event.runStartedAt
  const { startedAt: previousStart, ...withoutStart } = state
  const base = admission
    ? { ...withoutStart, admission, ...(startedAt !== undefined && Number.isFinite(startedAt) ? { startedAt } : {}) }
    : startedAt !== undefined && Number.isFinite(startedAt) && (!state.outcome || previousStart === undefined)
      ? { ...state, startedAt: Math.min(previousStart ?? startedAt, startedAt) } : state
  if (event.type === 'status') return { ...base, ...(event.data.label ? { label: event.data.label } : {}), ...(event.data.health && !state.completion ? { health: event.data.health } : {}) }
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
  if (event.type === 'complete') return { ...base, ...(base.health ? { health: completeRunHealth(base.health, event.data.taskOutcome?.status) } : {}), outcome: event.data.status, completion: event.data, ...(Number.isFinite(event.timestamp) ? { endedAt: state.completion ? state.endedAt ?? event.timestamp : event.timestamp } : {}) }
  if (event.type === 'error') return state.completion ? base : { ...base, outcome: 'failed', errorMessage: event.data.message, ...(Number.isFinite(event.timestamp) ? { endedAt: state.endedAt ?? event.timestamp } : {}) }
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

const OpenDiffContext = createContext<((path: string) => void) | undefined>(undefined)
export function changedToolPaths(step: TraceStep): string[] {
  if (step.kind !== 'tool' || step.status !== 'succeeded') return []
  const tools = new Set(['fs.write', 'fs.apply_patch', 'fs.apply_patches', 'fs.stage', 'fs.move', 'plan.write'])
  if (!tools.has(step.tool ?? '')) return []
  if (step.tool === 'fs.stage' && step.args?.operation !== 'commit' && step.preview?.committed !== true) return []
  const path = str(step.preview?.path) ?? str(step.args?.destination) ?? str(step.args?.path)
  return path ? [path] : []
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

function StepRow({ step, live, showModel = true }: { step: TraceStep; live: boolean; showModel?: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const openDiff = useContext(OpenDiffContext)
  const diffPath = openDiff ? changedToolPaths(step)[0] : undefined
  const seenLive = useRef(false)
  if (live) seenLive.current = true
  if (step.kind === 'tool') {
    const { icon, text } = summarizeTool(step)
    const hasDetail = Boolean(step.error || step.args || step.preview)
    const open = userOpen ?? step.status === 'failed'
    return <div className={`trace-step trace-tool trace-${step.status ?? 'running'}`}>
      <PulseButton type="button" className="trace-row" onClick={() => diffPath ? openDiff?.(diffPath) : setUserOpen(!open)} title={diffPath ? `查看 ${diffPath} 的差异` : undefined} aria-expanded={diffPath ? undefined : open} disabled={!diffPath && !hasDetail}>
        <span className="trace-state">{step.status === 'running' ? <i className="trace-spin" /> : step.status === 'succeeded' ? '✓' : step.status === 'failed' ? '✕' : '–'}</span>
        <span className="trace-icon"><Icon name={icon} size={14}/></span><span className="trace-text">{text}</span>
        {(diffPath || hasDetail) && <span className="trace-caret">{!diffPath && open ? '▾' : '▸'}</span>}
      </PulseButton>
      {open && hasDetail && <ToolDetail step={step} />}
    </div>
  }
  const body = step.reasoning
  const open = userOpen ?? (live || seenLive.current)
  const task = TASK_LABEL[step.task ?? ''] ?? step.task ?? '推理'
  return <div className="trace-step trace-llm">
    <PulseButton type="button" className="trace-row" onClick={() => setUserOpen(!open)} aria-expanded={open} disabled={!body}>
      <span className="trace-state">{live ? <i className="trace-spin" /> : '◆'}</span>
      <span className="trace-text">{live ? '思考中' : '思考'} · {task}</span>
      {showModel && step.modelId && <span className={`trace-model ${step.fallback ? 'is-fallback' : ''}`} title={step.fallback ? '已回退到备用模型' : undefined}>{step.modelId}{step.fallback ? ' · 回退' : ''}</span>}
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
  const multipleModels = new Set(lane.steps.flatMap(step => step.modelId ? [step.modelId] : [])).size > 1
  const tools = lane.steps.filter(step => step.kind === 'tool').length
  return <section className={`trace-lane trace-lane-${lane.status}`} style={{ marginLeft: depth * 14 }}>
    <PulseButton type="button" className="trace-lane-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
      <span className={`trace-dot dot-${lane.status}`} />
      <span className="trace-lane-title"><strong>{lane.label}</strong>{lane.goal && <small>{shorten(lane.goal, 90)}</small>}</span>
      {badge && <span className={`trace-model ${badge.fallback ? 'is-fallback' : ''}`} title={badge.fallback ? '本任务使用过备用模型' : badge.label}>{badge.label}</span>}
      <small className="trace-lane-meta">{LANE_STATUS[lane.status] ?? lane.status}{tools ? ` · ${tools} 工具` : ''}</small>
      <span className="trace-caret">{open ? '▾' : '▸'}</span>
    </PulseButton>
    {open && <div className="trace-lane-body">
      {lane.steps.length === 0 && <p className="trace-empty">等待执行…</p>}
      <RunProgress trace={{ order: [lane.id], lanes: { [lane.id]: lane } }} running={active} includeThoughts showModels={multipleModels} />
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
  const emptyProgress = /^阶段进度[:：]0\/0(?:[,，·]0项受阻)?$/.test(state.label?.replace(/\s/g, '') ?? '')
  const latest = state.order.flatMap(id => state.lanes[id]?.steps ?? []).at(-1)
  const phase = latest?.kind === 'llm' ? TASK_LABEL[latest.task ?? ''] : undefined
  const label = emptyProgress ? undefined : state.label
  const processPending = latest?.kind === 'tool' && shellProcessPending(latest.tool, latest.status, latest.preview)
  const head = running ? (processPending ? presentRun({ state: 'running', waiting: 'process' }).label : label ?? (phase ? `正在${phase}` : presentRun({ state: 'running' }).label)) : state.outcome ? presentRun({ state: state.outcome, ...(state.completion ? { completion: state.completion } : {}) }).label : '已结束'
  return `${head}${lanes > 1 ? ` · ${lanes} 个执行分支` : ''}${tools ? ` · ${tools} 次工具调用` : ''}`
}

/** Server wall-clock timestamps only; never fabricate elapsed time from page load. */
export function traceDuration(trace: Pick<TraceState, 'startedAt' | 'endedAt'>): string | undefined {
  const { startedAt, endedAt } = trace
  if (startedAt === undefined || endedAt === undefined || !Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return undefined
  const seconds = Math.floor((endedAt - startedAt) / 1000)
  if (!seconds) return '不足 1 秒'
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', rest ? `${rest} 秒` : ''].filter(Boolean).join(' ')
}

function progressState(step: TraceStep): string {
  return step.status === 'succeeded' ? '已完成' : step.status === 'failed' ? '失败' : step.status === 'cancelled' ? '已停止' : '进行中'
}

function ProgressFailure({ step }: { step: TraceStep }) {
  return <div className="progress-failure">
    <span className="progress-failure-mark" aria-hidden="true">!</span>
    <div><strong>{summarizeTool(step).text}</strong><p>{String(step.error?.message ?? step.error?.code ?? '操作失败')}</p></div>
  </div>
}

/** Consecutive tool calls stay inspectable without turning updates into a log wall. */
function ProgressTools({ steps }: { steps: TraceStep[] }) {
  const [open, setOpen] = useState(false)
  const openDiff = useContext(OpenDiffContext)
  const diffPath = openDiff && steps.length === 1 ? changedToolPaths(steps[0]!)[0] : undefined
  const active = [...steps].reverse().find(step => !step.status || step.status === 'running')
  const failures = steps.filter(step => step.status === 'failed')
  const counts = new Map<string, number>()
  const verbs: Record<string, string> = { 'fs.read': '读取文件', 'fs.list': '查看目录', 'fs.search': '搜索文件', 'shell.exec': '运行命令', 'web.search': '搜索网页', 'web.fetch': '读取网页' }
  for (const step of steps) { const verb = verbs[step.tool ?? ''] ?? '工具操作'; counts.set(verb, (counts.get(verb) ?? 0) + 1) }
  const label = active ? summarizeTool(active).text : steps.length === 1 ? summarizeTool(steps[0]!).text : [...counts].map(([verb, count]) => `${verb} ${count}`).join(' · ')
  return <div className="progress-tools">
    <button type="button" className="progress-batch-head" title={diffPath ? `查看 ${diffPath} 的差异` : undefined} aria-expanded={diffPath ? undefined : open} onClick={() => diffPath ? openDiff?.(diffPath) : setOpen(value => !value)}>
      <span className={`progress-batch-state ${failures.length ? 'has-failure' : ''}`} aria-label={active ? '进行中' : failures.length ? '有操作失败' : '操作记录'}>{active ? <i className="trace-spin" /> : <Icon name={summarizeTool(steps[steps.length - 1]!).icon} size={14}/>}</span>
      <span className="progress-batch-label">{label}</span>
      {failures.length > 0 && <small>{failures.length} 项失败</small>}
      <Icon className={open ? 'progress-batch-caret is-open' : 'progress-batch-caret'} name="chevron" size={11}/>
    </button>
    {open && <div className="progress-tool-list">
      {steps.map(step => <div className={`progress-result progress-${step.status ?? 'running'}`} key={step.id}>
        <span className="progress-result-state">{progressState(step)}</span><span>{summarizeTool(step).text}</span>
        <ToolDetail step={step} />
      </div>)}
    </div>}
    {!open && failures.map(step => <ProgressFailure key={step.id} step={step} />)}
  </div>
}

/** Public progress prose remains visible alongside compact tool summaries. */
function RunProgress({ trace, running, includeThoughts = false, showModels = false }: { trace: TraceState; running: boolean; includeThoughts?: boolean; showModels?: boolean }) {
  const groups: Array<{ kind: 'note'; id: string; note: string } | { kind: 'tools'; id: string; lane: string; steps: TraceStep[] } | { kind: 'thought'; id: string; step: TraceStep; live: boolean }> = []
  for (const laneId of trace.order) for (const step of trace.lanes[laneId]?.steps ?? []) {
    const id = `${laneId}:${step.id}`
    if (step.kind === 'tool') {
      const last = groups[groups.length - 1]
      if (last?.kind === 'tools' && last.lane === laneId && !changedToolPaths(step).length && !last.steps.some(item => changedToolPaths(item).length)) last.steps.push(step)
      else groups.push({ kind: 'tools', id, lane: laneId, steps: [step] })
    } else {
      if (includeThoughts && (step.reasoning || step.modelId)) groups.push({ kind: 'thought', id: `${id}:thought`, step, live: running && step.id === trace.lanes[laneId]?.steps.at(-1)?.id })
      if (step.note?.trim()) groups.push({ kind: 'note', id: `${id}:note`, note: step.note })
    }
  }
  if (!groups.length) return null
  return <div className="run-progress" role={running ? "log" : "region"} aria-label="工作进展" aria-live={running ? "polite" : "off"} aria-relevant="additions text">
    {groups.map(group => group.kind === 'tools' ? <ProgressTools key={group.id} steps={group.steps} /> : group.kind === 'thought' ? <StepRow key={group.id} step={group.step} live={group.live} showModel={showModels || Boolean(group.step.fallback)} /> : <div className="progress-note" key={group.id}><Markdown text={group.note} /></div>)}
  </div>
}

/** One disclosure per run: public progress folds with technical details at completion. */
export function RunTraceView({ trace, running: streamRunning, onDiffClick, compact = false }: { trace: TraceState; running: boolean; onDiffClick?: ((path: string) => void) | undefined; compact?: boolean }) {
  const running = streamRunning && !trace.outcome
  const presentation = presentRun({ state: trace.outcome ?? 'running', ...(trace.completion ? { completion: trace.completion } : {}) })
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const [wasRunning, setWasRunning] = useState(running)
  const bodyId = useId()
  // Reset once at lifecycle transitions; replay and late events retain manual expansion.
  if (wasRunning !== running) { setWasRunning(running); setUserOpen(undefined) }
  const open = wasRunning !== running ? false : userOpen ?? false
  const elapsed = !running ? traceDuration(trace) : undefined
  const label = running ? admissionLabel(trace.admission) ?? (compact ? '执行详情' : summary(trace, true)) : elapsed ? `耗时 ${elapsed}` : '执行过程'
  const status = !running && trace.outcome ? presentation.label : ''
  const problem = trace.outcome === 'failed' && !trace.completion?.errorCode ? trace.errorMessage : undefined
  const roots = trace.order.filter(id => { const lane = trace.lanes[id]!; return !lane.parentId || !trace.lanes[lane.parentId] })
  const render = (id: string): ReactElement[] => {
    const lane = trace.lanes[id]!
    const children = trace.order.filter(childId => trace.lanes[childId]?.parentId === id)
    return [<LaneCard key={id} lane={lane} depth={laneDepth(trace, lane)} runActive={running} />, ...children.flatMap(render)]
  }
  return <OpenDiffContext.Provider value={onDiffClick}><div className={`run-trace ${running ? 'is-running' : 'is-finished'} outcome-${trace.outcome ?? 'unknown'}`}>
    {running && !compact && !open && <RunProgress trace={trace} running />}
    <PulseButton type="button" className="run-trace-head" onClick={() => setUserOpen(!open)} aria-controls={bodyId} aria-label={['执行过程', status, label === '执行过程' ? '' : label].filter(Boolean).join('，')} aria-expanded={open}>
      {running && <span className="trace-dot dot-running" />}
      <span className="run-trace-label">{label}</span>
      <Icon className={open ? 'run-trace-caret is-open' : 'run-trace-caret'} name="chevron" size={12}/>
      {!running && trace.outcome && !['accepted', 'finished'].includes(presentation.state) && <small className="run-trace-outcome">{status}</small>}
    </PulseButton>
    {problem && <p className="run-trace-problem">{problem}</p>}
    {open && <div id={bodyId} className="run-trace-body" role="region" aria-label="执行过程" tabIndex={0}>
      {trace.order.length === 0 ? <p className="trace-empty">暂无可用过程记录</p> : <div className="run-trace-details"><small className="run-trace-statistics">{summary(trace, running)}</small>{roots.flatMap(render)}</div>}
    </div>}
  </div></OpenDiffContext.Provider>
}

/** History keeps summaries usable when its optional process trace needs a retry. */
export function PersistedRunTrace({ runId, transport, onDiffClick }: { runId: string; transport: PulseWebTransport; onDiffClick?: ((path: string) => void) | undefined }) {
  const [load, setLoad] = useState<{ runId: string; transport: PulseWebTransport; trace?: TraceState; error?: boolean }>()
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoad({ runId, transport })
    apiJson<{ events: WebRunEvent[] }>(transport, `/api/runs/${encodeURIComponent(runId)}/trace`)
      .then(result => { if (!cancelled) setLoad({ runId, transport, trace: result.events.reduce(reduceTrace, emptyTrace) }) })
      .catch(() => { if (!cancelled) setLoad({ runId, transport, error: true }) })
    return () => { cancelled = true }
  }, [runId, transport, retry])
  if (load?.runId !== runId || load.transport !== transport) return null
  if (load.error) return <div className="run-trace run-trace-unavailable" role="status"><span>过程记录暂不可用</span><PulseButton type="button" aria-label="重试加载执行过程" onClick={() => setRetry(value => value + 1)}>重试</PulseButton></div>
  if (!load.trace) return null
  return <RunTraceView key={runId} trace={load.trace} running={false} onDiffClick={onDiffClick} />
}
