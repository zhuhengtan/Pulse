import { useEffect, useRef, useState } from 'react'
import { PulseButton, PulseCheckbox, PulseTextArea } from './PulseControls.js'
import { Icon } from './Icon.js'

export type PendingInteraction = {
  kind: 'interaction'; runId: string; groupId: string; interactionKind: 'ask' | 'approval'
  items: Array<{ effectId: string; input: Record<string, unknown> }>
  conversationId?: string; conversationTitle?: string; projectId?: string; approvalPolicy?: 'manual' | 'delegate'
}
type Answer = { value: string; text?: string } | { values: string[] } | { text: string }
const executionPhrase = (text: string) => /^(?:同意执行|确认执行|批准执行|按此方案执行|approve execution|execute the plan)$/i.test(text.trim().replace(/[。！!.]+$/u, '').trim())
const planExecutionQuestion = (input: Record<string, unknown>) => {
  const options = Array.isArray(input.options) ? input.options : []
  if (options.length !== 2) return false
  const label = (option: unknown) => typeof option === 'string' ? option : option && typeof option === 'object' && !Array.isArray(option) && typeof (option as { label?: unknown }).label === 'string' ? (option as { label: string }).label : ''
  return /^暂不执行/u.test(label(options[0]).trim()) && /^执行/u.test(label(options[1]).trim())
}
type Props = {
  interaction: PendingInteraction; context?: string | undefined; reviewNote: string; delegated: boolean
  draftScope?: string | undefined
  onDismiss?: (() => void) | undefined
  notificationTarget?: string | undefined
  onOpenConversation?: (() => void) | undefined
  onOpenFile?: ((path: string) => void) | undefined
  submit: (answers: Array<{ effectId: string; value: Record<string, unknown> }>) => Promise<boolean>
}

export function InteractionPanel({ interaction, context, reviewNote, delegated, submit, onOpenConversation, onOpenFile, notificationTarget, onDismiss, draftScope }: Props) {
  const key = `pulse-web-interaction:${interaction.runId}:${interaction.groupId}${draftScope ? `:${draftScope}` : ''}`
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (notificationTarget !== interaction.groupId) return
    panel.current?.scrollIntoView?.({ block: 'nearest' })
    const field = panel.current?.querySelector<HTMLElement>('textarea, input') ?? panel.current?.querySelector<HTMLElement>('button')
    field?.focus()
  }, [interaction.groupId, notificationTarget])
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => {
    let restored: Record<string, Answer> = {}
    try { const saved = JSON.parse(localStorage.getItem(key) ?? '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) restored = saved } catch { /* Optional draft cache. */ }
    for (const question of interaction.items) {
      if (!restored[question.effectId] && question.input.type === 'input' && typeof question.input.defaultValue === 'string') restored[question.effectId] = { text: question.input.defaultValue }
      if (!restored[question.effectId] && question.input.type === 'multi' && (typeof question.input.min !== 'number' || question.input.min === 0)) restored[question.effectId] = { values: [] }
    }
    return restored
  })
  const [index, setIndex] = useState(0)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  const item = interaction.items[index], input = item?.input ?? {}, selected = item ? answers[item.effectId] : undefined
  const options = (Array.isArray(input.options) ? input.options as Array<string | { value: string; label?: string; description?: string }> : [])
    .map(option => typeof option === 'string' ? { value: option, label: option } : option)
    .filter(option => option.value?.trim() && (option.label ?? option.value).trim())
  const persist = (next: Record<string, Answer>) => {
    setAnswers(next); setError('')
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { setError('浏览器无法保存答案草稿，请保持当前页面打开。') }
  }
  const submittedAnswer = (question: PendingInteraction['items'][number]): Record<string, unknown> => {
    const answer = answers[question.effectId]
    if (answer && 'value' in answer && answer.value) return { value: answer.value }
    if (answer && 'text' in answer && answer.text?.trim()) return { text: answer.text }
    if (answer && 'values' in answer) return { values: answer.values }
    return { values: [] }
  }
  const answerValid = (question: PendingInteraction['items'][number]) => {
    const answer = answers[question.effectId]
    if (question.input.type === 'choice' && answer && 'value' in answer && answer.value) return true
    if (answer && 'text' in answer) {
      const text = answer.text ?? ''
      if (!text.trim() || text.length > 4000) return false
      if (question.input.type === 'choice' && planExecutionQuestion(question.input) && executionPhrase(text)) return false
      return true
    }
    if (question.input.type === 'choice') return false
    if (question.input.type === 'multi') {
      const values = answer && 'values' in answer && Array.isArray(answer.values) ? answer.values : []
      return values.length >= (typeof question.input.min === 'number' ? question.input.min : 0) && values.length <= (typeof question.input.max === 'number' ? question.input.max : Infinity)
    }
    return false
  }
  const update = (value: Answer) => { if (item) persist({ ...answers, [item.effectId]: value }) }
  const submitBatch = async (values: Array<{ effectId: string; value: Record<string, unknown> }>) => {
    if (locked.current) return
    locked.current = true; setSending(true); setError('')
    try {
      if (await submit(values)) {
        setDone(true)
        try { localStorage.removeItem(key) } catch { /* Acknowledgement already received. */ }
      } else { locked.current = false; setError('提交失败，内容已保留；请检查连接后重试。') }
    } catch { locked.current = false; setError('提交失败，内容已保留；请检查连接后重试。') }
    finally { setSending(false) }
  }
  if (done || !interaction.items.length) return null
  const contextLine = context && <div className="interaction-context"><span>{context}</span>{onOpenConversation && <PulseButton onClick={onOpenConversation}>打开工作会话<Icon name="chevron" size={12}/></PulseButton>}</div>
  if (interaction.interactionKind === 'approval') {
    const tools = interaction.items.flatMap(entry => Array.isArray(entry.input.tools) ? entry.input.tools as Array<{ toolName?: string; details?: Record<string, unknown> }> : [])
    const count = interaction.items.reduce((total, entry) => total + (typeof entry.input.operationCount === 'number' ? entry.input.operationCount : Array.isArray(entry.input.tools) ? entry.input.tools.length : 1), 0)
    const title = count > 1 ? `允许执行这 ${count} 项操作？` : tools[0]?.toolName === 'shell.exec' ? '允许执行此命令？' : tools[0]?.toolName?.startsWith('fs.') ? '允许访问这些文件？' : '允许执行此操作？'
    const decide = (approved: boolean) => void submitBatch(interaction.items.map(entry => ({ effectId: entry.effectId, value: approved ? { approved: true } : { approved: false, reason: '用户拒绝' } })))
    return <section ref={panel} className="interaction-panel approval-panel" aria-label="待审批操作" aria-busy={sending}>
      <div className="interaction-heading"><Icon name="shield" size={16}/><strong>{title}</strong></div>
      {contextLine}
      <div className="interaction-scroll">
        {interaction.items.map(entry => <p className="interaction-description" key={entry.effectId}>{typeof entry.input.prompt === 'string' ? entry.input.prompt : 'Pulse 需要你确认以下操作。'}</p>)}
        <details className="approval-operation-list" open={count === 1 ? true : undefined}>
          <summary hidden={count === 1}>查看全部 {count} 项操作</summary>
          <div className="approval-operations">{tools.map((tool, i) => <div className="approval-operation" key={i}>
          <span className="approval-tool">{tool.toolName ?? '操作'}</span>
          {typeof tool.details?.command === 'string' && <pre><code>{tool.details.command}{Array.isArray(tool.details.args) ? tool.details.args.map(arg => ` ${JSON.stringify(arg)}`).join('') : ''}</code></pre>}
          {typeof tool.details?.path === 'string' && <code>{tool.details.path}</code>}
          {Object.keys(tool.details ?? {}).some(name => !['command', 'args', 'path'].includes(name)) && <details className="technical-details"><summary>更多操作细节</summary><pre>{JSON.stringify(tool.details, null, 2)}</pre></details>}
        </div>)}</div></details>
        {(reviewNote || delegated) && <p className="review-note" role="status"><Icon name="info" size={14}/><span>{reviewNote || '自动审核需要你确认本次操作。'}</span></p>}
      </div>
      {error && <p className="interaction-error" role="alert">{error}</p>}
      <div className="interaction-actions"><PulseButton disabled={sending} onClick={() => decide(false)}>拒绝</PulseButton><PulseButton className="primary" disabled={sending} onClick={() => decide(true)}>{sending ? '正在提交…' : '允许本次'}</PulseButton></div>
    </section>
  }
  const count = interaction.items.length
  const prompt = String(input.prompt ?? '请回答')
  const planPath = typeof input.planPath === 'string' ? input.planPath : prompt.match(/docs\/plans\/[^\s`，。；,;？?]+\.md/u)?.[0]
  const planStart = planPath ? prompt.indexOf(planPath) : -1
  const openPlan = planPath && onOpenFile ? <button type="button" className="question-plan-link" onClick={() => onOpenFile(planPath)}>{planPath}</button> : null
  return <section ref={panel} className="interaction-panel ask-panel" aria-label="待回答问题" aria-busy={sending}>
    <div className="interaction-heading"><Icon name="info" size={16}/><strong>需要你的回答</strong>{count > 1 && <span>第 {index + 1} / {count} 题</span>}<PulseButton className="icon-button question-close" aria-label="不作答并关闭" title="不作答并关闭" disabled={sending} onClick={() => onDismiss ? onDismiss() : void submitBatch(interaction.items.map(question => ({ effectId: question.effectId, value: { dismissed: true } })))}><Icon name="close" size={16}/></PulseButton></div>
    {contextLine}
    <div className="question-scroll">
      <h3>{openPlan && planStart >= 0 ? <>{prompt.slice(0, planStart)}{openPlan}{prompt.slice(planStart + planPath!.length)}</> : prompt}</h3>{openPlan && planStart < 0 && <p>{openPlan}</p>}
      {typeof input.context === 'string' && input.context && <p className="question-background">{input.context}</p>}
      {input.type === 'choice' && <div className="question-options">{options.map(choice => {
        const active = Boolean(selected && 'value' in selected && selected.value === choice.value)
        return <PulseButton className={`question-option ${active ? 'selected' : ''}`} aria-pressed={active} disabled={sending} key={choice.value} onClick={() => update({ value: choice.value })}><span className="question-radio" aria-hidden="true">{active ? '●' : ''}</span><span><strong>{choice.label ?? choice.value}</strong>{choice.description && <span className="question-option-description">{choice.description}</span>}</span></PulseButton>
      })}</div>}
      {input.type === 'multi' && <><p className="question-hint">可多选{typeof input.min === 'number' && input.min > 0 ? `，至少 ${input.min} 项` : ''}{typeof input.max === 'number' ? `，最多 ${input.max} 项` : ''}</p><div className="question-options multi">{options.map(choice => {
        const values = selected && 'values' in selected ? selected.values : [], checked = values.includes(choice.value)
        return <PulseCheckbox key={choice.value} disabled={sending || !checked && values.length >= (typeof input.max === 'number' ? input.max : Infinity)} checked={checked} onChange={() => update({ values: checked ? values.filter(value => value !== choice.value) : [...values, choice.value] })}><strong>{choice.label ?? choice.value}</strong>{choice.description && <span className="question-option-description">{choice.description}</span>}</PulseCheckbox>
      })}</div></>}
      {(input.type === 'choice' || input.type === 'multi') && <div className="question-custom"><PulseTextArea aria-label="自行回答" maxLength={4000} rows={2} value={selected && 'text' in selected ? selected.text ?? '' : ''} disabled={sending} placeholder="输入你的答案…" onChange={event => { const text = event.target.value; if (input.type === 'choice' && selected && 'value' in selected && selected.value && planExecutionQuestion(input)) update({ value: selected.value, text }); else update({ text }) }}/></div>}
      {input.type === 'choice' && planExecutionQuestion(input) && !(selected && 'value' in selected && selected.value) && executionPhrase(selected && 'text' in selected ? selected.text ?? '' : '') && <p className="interaction-error" role="status">请点选「执行」。输入这句话不能代替确认。</p>}
      {input.type === 'input' && <PulseTextArea aria-label="你的答案" maxLength={4000} rows={3} className="question-input" value={selected && 'text' in selected ? selected.text : ''} disabled={sending} placeholder={typeof input.placeholder === 'string' ? input.placeholder : '请输入'} onChange={event => update({ text: event.target.value })}/>}
    </div>
    {error && <p className="interaction-error" role="alert">{error}</p>}
    <div className="interaction-actions ask-actions">{count > 1 && <PulseButton disabled={sending || index === 0} onClick={() => setIndex(value => value - 1)}>上一题</PulseButton>}{index < count - 1 ? <PulseButton className="primary" disabled={sending || !item || !answerValid(item)} onClick={() => setIndex(value => value + 1)}>下一题</PulseButton> : <PulseButton className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={() => void submitBatch(interaction.items.map(question => ({ effectId: question.effectId, value: submittedAnswer(question) })))}>{sending ? '正在提交…' : '提交回答'}</PulseButton>}</div>
  </section>
}
