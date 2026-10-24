/** Versioned presentation data. Never used as tool authorization or model instructions. */
export interface RichNode {
  type: string
  text?: string
  attrs?: Record<string, string | number | null>
  marks?: Array<{ type: string; attrs?: Record<string, string | number | null> }>
  content?: RichNode[]
}
export interface RichContent { version: 1; document: RichNode }

export function safeRichLink(value: string): boolean {
  if (!/^(https?:\/\/|mailto:)/i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false
  try { const url = new URL(value); return url.protocol === 'mailto:' ? Boolean(url.pathname) : Boolean(url.hostname) } catch { return false }
}

/** Validate and copy a bounded, known schema instead of storing arbitrary editor/HTML data. */
export function parseRichContent(value: unknown): RichContent | undefined {
  if (value === undefined) return undefined
  const fail = (): never => { throw new Error('RICH_CONTENT_INVALID') }
  if (!value || typeof value !== 'object' || (value as RichContent).version !== 1) return fail()
  if (JSON.stringify(value).length > 262_144) return fail()
  let count = 0
  const inline = new Set(['text', 'hardBreak', 'skillChip', 'fileChip'])
  const blocks = new Set(['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule'])
  const read = (raw: unknown, depth: number, parent: string): RichNode => {
    if (++count > 10_000 || depth > 24 || !raw || typeof raw !== 'object') return fail()
    const item = raw as RichNode, type = item.type
    if (parent === '' ? type !== 'doc' : parent === 'doc' || parent === 'blockquote' || parent === 'listItem' ? !blocks.has(type) : parent === 'bulletList' || parent === 'orderedList' ? type !== 'listItem' : parent === 'codeBlock' ? type !== 'text' : !inline.has(type)) return fail()
    const out: RichNode = { type }
    if (item.attrs !== undefined && (!item.attrs || typeof item.attrs !== 'object' || Array.isArray(item.attrs))) return fail()
    if (item.marks !== undefined && !Array.isArray(item.marks)) return fail()
    const attrs = item.attrs ?? {}
    const str = (key: string, max = 4096) => { const v = attrs[key]; if (typeof v !== 'string' || v.length > max || /[\u0000\r\n]/.test(v)) return fail(); return v }
    if (type === 'text') { if (typeof item.text !== 'string' || !item.text.length) return fail(); out.text = item.text }
    if (type === 'heading') { if (![1, 2, 3].includes(Number(attrs.level))) return fail(); out.attrs = { level: Number(attrs.level) } }
    if (type === 'orderedList') { const start = attrs.start ?? 1; if (!Number.isSafeInteger(start) || Number(start) < 1 || Number(start) > 1_000_000) return fail(); out.attrs = { start: Number(start) } }
    if (type === 'codeBlock' && attrs.language != null) out.attrs = { language: str('language', 64) }
    if (type === 'skillChip' || type === 'fileChip') out.attrs = { id: str('id'), label: str('label') }
    if (item.marks?.length) {
      if (!inline.has(type) || type === 'hardBreak' || parent === 'codeBlock' || item.marks.length > 8) return fail()
      out.marks = item.marks.map(mark => {
        if (!mark || typeof mark !== 'object') return fail()
        if (!['bold', 'italic', 'strike', 'code', 'underline', 'link'].includes(mark.type)) return fail()
        if (mark.type !== 'link') return { type: mark.type }
        const href = mark.attrs?.href
        if (typeof href !== 'string' || href.length > 4096 || !safeRichLink(href)) return fail()
        return { type: 'link', attrs: { href } }
      })
    }
    if (inline.has(type) || type === 'horizontalRule') { if (item.content?.length) return fail() }
    else {
      if (!Array.isArray(item.content) && item.content !== undefined) return fail()
      out.content = (item.content ?? []).map(child => read(child, depth + 1, type))
      if ((type === 'doc' || type === 'listItem' || type === 'bulletList' || type === 'orderedList' || type === 'blockquote') && !out.content.length) return fail()
      if (type === 'listItem' && out.content[0]?.type !== 'paragraph') return fail()
    }
    return out
  }
  return { version: 1, document: read((value as RichContent).document, 0, '') }
}
