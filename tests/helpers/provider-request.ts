type Message = { name?: string; role?: string; content?: unknown }
function nativeResults(messages: Message[]): Array<{ id: string; value: any }> {
  return messages.filter(message => message.role === 'tool').flatMap(message => {
    try { const body = JSON.parse(String(message.content)); return typeof body.runtimeResultRef === 'string' ? [{ id: body.runtimeResultRef, value: body.result }] : [] } catch { return [] }
  })
}
function historyRows(message: Message): any[] | undefined {
  try {
    const rows = JSON.parse(String(message.content))
    return Array.isArray(rows) && rows.length > 0 && rows.every(r => typeof r.seq === 'number' && typeof r.instruction === 'string') ? rows : undefined
  } catch { return undefined }
}
/** Route simulated responses by the current request, not archived instructions. */
export function currentRequestText(messages: Message[]): string {
  const current: Message[] = []
  const snapshots: Array<{ index: number; value: Record<string, any> }> = []
  for (const message of messages) {
    if (message.name === 'history' || message.name === 'provider_history' || historyRows(message) || message.role === 'tool') continue
    let value: any
    try { value = JSON.parse(String(message.content)) } catch { /* ordinary text */ }
    if (value?.contextUpdate) {
      const { set = {}, append = {}, removed = [] } = value.contextUpdate
      const keys = [...Object.keys(set), ...Object.keys(append), ...removed]
      const target = snapshots.findLast(snapshot => keys.some(key => key in snapshot.value))
      if (target) {
        Object.assign(target.value, set)
        for (const [key, items] of Object.entries(append)) target.value[key] = [...(target.value[key] ?? []), ...(items as any[])]
        for (const key of removed) delete target.value[key]
        if (target.value.activeStage?.id) target.value.activeStage = { id: target.value.activeStage.id, ...target.value.activeStage }
        current[target.index] = { ...current[target.index], content: JSON.stringify(target.value) }
        continue
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) snapshots.push({ index: current.length, value })
    current.push(message)
  }
  return current.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).join('\n')
}
/** Resolve the compact reference catalog against evidence retained in history. */
export function suppliedRequestResults(messages: Message[]): Array<{ id: string; value: any }> {
  const history = messages.flatMap(m => historyRows(m) ?? [])
  const bodies = new Map(history.flatMap((record: any) => (record.evidence ?? []).map((e: any) => [e.ref, e.value])))
  return [...nativeResults(messages), ...messages.filter(m => m.name === 'results').flatMap(m => JSON.parse(String(m.content))).map((r: any) => r.fromHistory ? { ...r, value: bodies.get(r.id) } : r)]
}
export function retainedRequestResults(messages: Message[]): Array<{ id: string; value: any }> {
  const retained = messages.flatMap(m => historyRows(m) ?? []).flatMap((r: any) => (r.evidence ?? []).map((e: any) => ({ id: e.ref, value: e.value })))
  return [...retained, ...suppliedRequestResults(messages)]
}
