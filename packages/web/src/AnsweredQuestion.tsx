import type { WebQuestionAnswer } from '@hunterzhu/pulse-server/protocol'
import { Icon } from './Icon.js'

/** A durable, read-only copy of the question and the accepted human answer. */
export function AnsweredQuestion({ question }: { question: WebQuestionAnswer }) {
  const { input, answer } = question
  const options = (Array.isArray(input.options) ? input.options : []).flatMap(option => {
    if (typeof option === 'string') return [{ value: option, label: option, description: '' }]
    if (!option || typeof option !== 'object' || typeof option.value !== 'string') return []
    return [{ value: option.value as string, label: typeof option.label === 'string' ? option.label : option.value as string, description: typeof option.description === 'string' ? option.description : '' }]
  })
  const selected = new Set(typeof answer.value === 'string' ? [answer.value] : Array.isArray(answer.values) ? answer.values.filter((value): value is string => typeof value === 'string') : [])
  const custom = typeof answer.text === 'string' ? answer.text : undefined
  const dismissed = answer.dismissed === true
  return <section className="answered-question" aria-label="已回答问题">
    <div className="interaction-heading"><Icon name="info" size={16}/><strong>{dismissed ? '未作答' : '已回答'}</strong></div>
    <h3>{String(input.prompt ?? '请回答')}</h3>
    {typeof input.context === 'string' && input.context && <p className="question-background">{input.context}</p>}
    {options.length > 0 && <ul className="question-options answered-question-options" aria-label="原问题选项">{options.map(option => {
      const checked = !dismissed && selected.has(option.value)
      return <li key={option.value} className={`question-option ${checked ? 'selected' : ''}`}>
        <span className={`question-radio ${input.type === 'multi' ? 'question-check' : ''}`} aria-hidden="true">{checked ? '✓' : ''}</span>
        <span><strong>{option.label}</strong>{option.description && <span className="question-option-description">{option.description}</span>}</span>
        {checked && <small className="question-answer-marker">已选择</small>}
      </li>
    })}</ul>}
    {!dismissed && custom !== undefined && <div className="question-answer-text"><small>{input.type === 'input' ? '你的回答' : '自行回答'}</small><p>{custom}</p></div>}
    {!dismissed && custom === undefined && Array.isArray(answer.values) && answer.values.length === 0 && <p className="question-hint">未选择任何选项</p>}
  </section>
}
