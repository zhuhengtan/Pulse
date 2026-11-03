/** A delayed acknowledgement must never postpone or outlive the actual reply. */
export function startChatAcknowledgement(persist: (text: string) => Promise<void>, generate?: (signal: AbortSignal) => Promise<string>, delayMs = 1200): () => Promise<void> {
  const controller = new AbortController()
  let stopped = false, text = '收到，我整理一下。', writing: Promise<void> | undefined
  if (generate) void generate(controller.signal).then(value => { if (!stopped && value.trim()) text = value.trim().slice(0, 80) }).catch(() => undefined)
  const timer = setTimeout(() => { if (!stopped) writing = persist(text).catch(() => undefined) }, delayMs)
  timer.unref()
  return async () => { stopped = true; clearTimeout(timer); controller.abort(); await writing }
}
