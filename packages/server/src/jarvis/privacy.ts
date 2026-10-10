/** Redact common credential forms before sending free-form text to memory. */
export function redactJarvisText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/("[^"\n]*(?:password|passwd|token|secret|credential|authorization|api[_-]?key|private[_-]?key|cookie)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\b((?:[\w-]*(?:password|passwd|token|secret|credential|api[_-]?key|private[_-]?key)[\w-]*)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw)
        let changed = false
        if (url.username || url.password) { url.username = ''; url.password = ''; changed = true }
        for (const key of [...url.searchParams.keys()]) {
          if (/(?:token|key|code|secret|signature|auth|credential)/i.test(key)) { url.searchParams.set(key, '[REDACTED]'); changed = true }
        }
        return changed ? url.toString() : raw
      } catch { return raw }
    })
}

export function jarvisMemoryTitle(text: string): string {
  return redactJarvisText(text).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Pulse task'
}
