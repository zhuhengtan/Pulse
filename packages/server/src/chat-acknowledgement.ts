/** A delayed acknowledgement must never postpone or outlive the actual reply. */
export function startChatAcknowledgement(persist: (text: string) => Promise<void>, generate?: (signal: AbortSignal) => Promise<string>, fallback = '', delayMs = 1200): () => Promise<void> {
  const controller = new AbortController()
  // No canned acknowledgement: the reply either comes from the model or from the caller's fallback.
  let stopped = false, text: string | undefined, writing: Promise<void> | undefined
  if (generate) void generate(controller.signal).then(value => { if (!stopped) { const generated = value.trim().slice(0, 80); if (generated) text = generated } }).catch(() => undefined)
  const timer = setTimeout(() => {
    const pending = text ?? fallback.trim().slice(0, 80)
    if (!stopped && pending) writing = persist(pending).catch(() => undefined)
  }, delayMs)
  timer.unref()
  return async () => { stopped = true; clearTimeout(timer); controller.abort(); await writing }
}
