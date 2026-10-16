type Message = { name?: string; role?: string; content?: unknown }
function historyRows(message: Message): any[] | undefined {
  try {
    const rows = JSON.parse(String(message.content))
    return Array.isArray(rows) && rows.length > 0 && rows.every(r => typeof r.seq === 'number' && typeof r.instruction === 'string') ? rows : undefined
  } catch { return undefined }
}
/** Route simulated responses by the current request, not archived instructions. */
export function currentRequestText(messages: Message[]): string {
  return messages.filter(m => m.name !== 'history' && m.name !== 'provider_history' && !historyRows(m)).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).join('\n')
}
/** Resolve the compact reference catalog against evidence retained in history. */
export function suppliedRequestResults(messages: Message[]): Array<{ id: string; value: any }> {
  const history = messages.flatMap(m => historyRows(m) ?? [])
  const bodies = new Map(history.flatMap((record: any) => (record.evidence ?? []).map((e: any) => [e.ref, e.value])))
  return messages.filter(m => m.name === 'results').flatMap(m => JSON.parse(String(m.content))).map((r: any) => r.fromHistory ? { ...r, value: bodies.get(r.id) } : r)
}
export function retainedRequestResults(messages: Message[]): Array<{ id: string; value: any }> {
  const retained = messages.flatMap(m => historyRows(m) ?? []).flatMap((r: any) => (r.evidence ?? []).map((e: any) => ({ id: e.ref, value: e.value })))
  return [...retained, ...suppliedRequestResults(messages)]
}
