import { useRef, useState } from 'react'
import { PulseButton, PulseCheckbox, PulseTextArea } from './PulseControls.js'
import { Icon } from './Icon.js'

export type PendingInteraction = {
  kind: 'interaction'; runId: string; groupId: string; interactionKind: 'ask' | 'approval'
  items: Array<{ effectId: string; input: Record<string, unknown> }>
  conversationId?: string; conversationTitle?: string; projectId?: string; approvalPolicy?: 'manual' | 'delegate'
}
type Answer = { value: string } | { values: string[] } | { text: string }
type Props = {
  interaction: PendingInteraction; context?: string | undefined; reviewNote: string; delegated: boolean
  onOpenConversation?: (() => void) | undefined
  submit: (answers: Array<{ effectId: string; value: Record<string, unknown> }>) => Promise<boolean>
}

export function InteractionPanel({ interaction, context, reviewNote, delegated, submit, onOpenConversation }: Props) {
  const key = `pulse-web-interaction:${interaction.runId}:${interaction.groupId}`
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
  const answerValid = (question: PendingInteraction['items'][number]) => {
    const answer = answers[question.effectId]
    if (answer && 'text' in answer) return typeof answer.text === 'string' && Boolean(answer.text.trim()) && answer.text.length <= 4000
    if (question.input.type === 'choice') return Boolean(answer && 'value' in answer && typeof answer.value === 'string' && answer.value.length)
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
    return <section className="interaction-panel approval-panel" aria-label="待审批操作" aria-busy={sending}>
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
  return <section className="interaction-panel ask-panel" aria-label="待回答问题" aria-busy={sending}>
    <div className="interaction-heading"><Icon name="info" size={16}/><strong>需要你的回答</strong>{count > 1 && <span>第 {index + 1} / {count} 题</span>}</div>
    {contextLine}
    <div className="question-scroll">
      <h3>{String(input.prompt ?? '请回答')}</h3>
      {typeof input.context === 'string' && input.context && <p className="question-background">{input.context}</p>}
      {input.type === 'choice' && <div className="question-options">{options.map(choice => {
        const active = Boolean(selected && 'value' in selected && selected.value === choice.value)
        return <PulseButton className={`question-option ${active ? 'selected' : ''}`} aria-pressed={active} disabled={sending} key={choice.value} onClick={() => update({ value: choice.value })}><span className="question-radio" aria-hidden="true">{active ? '●' : ''}</span><span><strong>{choice.label ?? choice.value}</strong>{choice.description && <span className="question-option-description">{choice.description}</span>}</span></PulseButton>
      })}</div>}
      {input.type === 'multi' && <><p className="question-hint">可多选{typeof input.min === 'number' && input.min > 0 ? `，至少 ${input.min} 项` : ''}{typeof input.max === 'number' ? `，最多 ${input.max} 项` : ''}</p><div className="question-options multi">{options.map(choice => {
        const values = selected && 'values' in selected ? selected.values : [], checked = values.includes(choice.value)
        return <PulseCheckbox key={choice.value} disabled={sending || !checked && values.length >= (typeof input.max === 'number' ? input.max : Infinity)} checked={checked} onChange={() => update({ values: checked ? values.filter(value => value !== choice.value) : [...values, choice.value] })}><strong>{choice.label ?? choice.value}</strong>{choice.description && <span className="question-option-description">{choice.description}</span>}</PulseCheckbox>
      })}</div></>}
      {(input.type === 'choice' || input.type === 'multi') && <details className="question-custom" open={Boolean(selected && 'text' in selected) || undefined}><summary>自行回答</summary><PulseTextArea aria-label="自行回答" maxLength={4000} rows={2} value={selected && 'text' in selected ? selected.text : ''} disabled={sending} placeholder="输入你的答案…" onChange={event => update({ text: event.target.value })}/></details>}
      {input.type === 'input' && <PulseTextArea aria-label="你的答案" maxLength={4000} rows={3} className="question-input" value={selected && 'text' in selected ? selected.text : ''} disabled={sending} placeholder={typeof input.placeholder === 'string' ? input.placeholder : '请输入'} onChange={event => update({ text: event.target.value })}/>}
    </div>
    {error && <p className="interaction-error" role="alert">{error}</p>}
    <div className="interaction-actions ask-actions">{count > 1 && <PulseButton disabled={sending || index === 0} onClick={() => setIndex(value => value - 1)}>上一题</PulseButton>}{index < count - 1 ? <PulseButton className="primary" disabled={sending || !item || !answerValid(item)} onClick={() => setIndex(value => value + 1)}>下一题</PulseButton> : <PulseButton className="primary" disabled={sending || interaction.items.some(question => !answerValid(question))} onClick={() => void submitBatch(interaction.items.map(question => ({ effectId: question.effectId, value: (answers[question.effectId] ?? { values: [] }) as Record<string, unknown> })))}>{sending ? '正在提交…' : '提交回答'}</PulseButton>}</div>
  </section>
}
