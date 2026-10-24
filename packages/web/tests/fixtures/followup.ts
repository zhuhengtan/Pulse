import { routingFixture } from './routing.js'
import type { WebConversation, WebMessage, WebRunEvent, WebRunSnapshot } from '../../src/transport.js'

/** Deterministic browser fixture. All model/work responses are synthetic. */
export function followupFixture(surface: 'chat' | 'work', ask = false) {
  const base = routingFixture(), request = base.transport.request, now = new Date().toISOString()
  const conversation: WebConversation = { id: surface === 'chat' ? 'assistant' : 'busy', title: '消息队列隔离验收', cwd: '/example/Pulse', createdAt: now, updatedAt: now, activeRunId: 'run-fixture-initial' }
  const messages: WebMessage[] = [{ id: 'initial-user', role: 'user', text: '正在执行的原始任务', runId: conversation.activeRunId!, createdAt: now }]
  const receipts: Array<{ messageId: string; runId: string; state: string; createdAt: string; updatedAt: string }> = [{ messageId: 'initial-user', runId: conversation.activeRunId!, state: 'replying', createdAt: now, updatedAt: now }]
  const calls: Array<{ path: string; body: any }> = []
  const connections = new Set<(connected: boolean) => void>()
  const listeners = new Set<() => void>(), subscriptions = new Map<string, Set<(event: WebRunEvent) => void>>()
  const states = new Map<string, WebRunSnapshot>()
  let seq = 0, ordinal = 0
  const interactions = () => ask ? [{ kind: 'ask' as const, groupId: 'fixture-question', items: [{ effectId: 'fixture-effect', input: { kind: 'ask', type: 'input', tool: 'ask.input', prompt: '只回答这个问题', context: '队列消息应保持待发' } }] }] : []
  states.set(conversation.activeRunId!, { runId: conversation.activeRunId!, state: 'running', seq, activities: [], interactions: interactions() })
  const notify = () => listeners.forEach(listener => listener())
  const emit = (event: WebRunEvent) => subscriptions.get(event.runId)?.forEach(listener => listener(event))
  const response = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))
  base.transport.onConnection = listener => { connections.add(listener); return () => { connections.delete(listener) } }
  base.transport.onChange = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  base.transport.subscribe = (path, onEvent) => {
    const runId = path.split('/')[3]!, items = subscriptions.get(runId) ?? new Set(); items.add(onEvent); subscriptions.set(runId, items)
    return () => { items.delete(onEvent) }
  }
  base.transport.subscribeChat = (runId, _after, onEvent) => base.transport.subscribe(`/api/runs/${runId}/events`, onEvent, () => {})
  const finish = (state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') => {
    const runId = conversation.activeRunId
    if (!runId) return
    ask = false; delete conversation.activeRunId
    const complete: Extract<WebRunEvent, { type: 'complete' }> = { type: 'complete', runId, seq: ++seq, data: { status: state } }
    states.set(runId, { runId, state, seq, activities: [], interactions: [], complete })
    for (const receipt of receipts) if (receipt.runId === runId) receipt.state = state === 'succeeded' ? 'completed' : state
    emit(complete); emit({ type: 'run_finished', runId, seq: ++seq }); notify()
  }
  base.transport.request = (path, init) => {
    if (path === '/api/session') return response({ queueScope: `followup-fixture-${surface}`, localAdmin: true })
    if (path === '/api/assistant') return response({ conversation: surface === 'chat' ? conversation : { ...conversation, id: 'assistant', activeRunId: undefined }, messages: surface === 'chat' ? messages : [], receipts: surface === 'chat' ? receipts : [], workInteractions: [] })
    if (path === '/api/conversations') return response(surface === 'work' ? [conversation] : [])
    if (path === `/api/conversations/${conversation.id}`) return response(conversation)
    if (path.endsWith('/state')) return response(states.get(path.split('/')[3]!))
    if (path.endsWith('/trace')) return response({ events: [], seq: 0 })
    if (path.includes('/messages') && init?.method !== 'POST') return response(messages)
    if (path.endsWith('/replies')) {
      const body = JSON.parse(String(init?.body)); calls.push({ path, body }); ask = false
      const runId = conversation.activeRunId!
      states.set(runId, { runId, state: 'running', seq: ++seq, activities: [], interactions: [] })
      emit({ type: 'interactions', runId, seq, data: { interactions: [] } }); notify(); return response({ ok: true })
    }
    if (path.endsWith('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); calls.push({ path, body })
      if (body.delivery === 'whenIdle' && conversation.activeRunId) return response({ error: 'CONVERSATION_BUSY' }, 409)
      const runId = conversation.activeRunId ?? `run-fixture-${++ordinal}`
      conversation.activeRunId = runId
      const prior = messages.find(message => message.id === `msg-${body.requestId}`)
      if (!prior) messages.push({ id: `msg-${body.requestId}`, requestId: body.requestId, role: 'user', text: body.text, runId, createdAt: now, ...(body.attachments ? { attachments: body.attachments } : {}), ...(body.richContent ? { richContent: body.richContent } : {}), ...(body.skills ? { skills: body.skills } : {}), ...(body.mentionedFiles ? { mentionedFiles: body.mentionedFiles } : {}) })
      receipts.push({ messageId: body.requestId, runId, state: 'replying', createdAt: now, updatedAt: now })
      states.set(runId, { runId, state: 'running', seq, activities: [], interactions: interactions() })
      notify()
      return response({ conversationId: conversation.id, messageId: body.requestId, runId, state: 'replying' })
    }
    if (path.endsWith('/cancel')) { calls.push({ path, body: {} }); finish('cancelled'); return response({ ok: true }) }
    return request(path, init)
  }
  return { transport: base.transport, calls, conversation, finish, states, subscriptions, setConnected: (connected: boolean) => connections.forEach(listener => listener(connected)) }
}
