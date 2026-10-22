import { safeRelativePath } from './routing.js'

export type PreviewTarget = { kind: 'start'; id: string } | { kind: 'tool'; tool: 'files' | 'git' | 'terminal' | 'automation' } | { kind: 'file'; path: string; projectId?: string; conversationId?: string; runId?: string } | { kind: 'browser'; sessionId: string } | { kind: 'diff'; path: string; projectId?: string; conversationId?: string; staged?: boolean }
export function previewKey(target: PreviewTarget): string { return target.kind === 'start' ? `start:${target.id}` : target.kind === 'tool' ? `tool:${target.tool}` : target.kind === 'browser' ? `browser:${target.sessionId}` : target.kind === 'diff' ? JSON.stringify(['diff', target.projectId ?? '', target.conversationId ?? '', target.path, target.staged === true]) : JSON.stringify([target.projectId ?? '', target.conversationId ?? '', target.runId ?? '', target.path]) }
export function readPreviewState(scope: string): { tabs: PreviewTarget[]; active?: string } {
  try {
    const value = JSON.parse(localStorage.getItem(`pulse-preview:${scope}`) ?? '{}')
    const tabs: PreviewTarget[] = Array.isArray(value.tabs) ? value.tabs.filter((item: any) => item?.kind === 'start' && typeof item.id === 'string' || item?.kind === 'tool' && ['files', 'git', 'terminal', 'automation'].includes(item.tool) || item?.kind === 'browser' && typeof item.sessionId === 'string' && Boolean(item.sessionId) || (item?.kind === 'file' || item?.kind === 'diff') && typeof item.path === 'string' && safeRelativePath(item.path) && (typeof item.projectId === 'string' || typeof item.conversationId === 'string' && (item.kind === 'diff' || typeof item.runId === 'string'))).slice(-30) : []
    return { tabs, ...(typeof value.active === 'string' ? { active: value.active } : {}) }
  } catch { return { tabs: [] } }
}
export function savePreviewState(scope: string, tabs: PreviewTarget[], active?: string) { try { localStorage.setItem(`pulse-preview:${scope}`, JSON.stringify({ tabs, active })) } catch { /* Private browsing/storage limits should not prevent preview. */ } }
export function fileApi(target: Extract<PreviewTarget, { kind: 'file' }>, action: 'raw' | 'ticket'): string {
  return target.runId && target.conversationId
    ? `/api/conversations/${encodeURIComponent(target.conversationId)}/artifacts/${action === 'raw' ? 'raw' : 'preview-ticket'}?${new URLSearchParams({ path: target.path, runId: target.runId })}`
    : `/api/projects/${encodeURIComponent(target.projectId ?? '')}/${action === 'raw' ? 'file-raw' : 'file-preview-ticket'}?${new URLSearchParams({ path: target.path })}`
}
export async function downloadPreview(response: Response, path: string) {
  if (!response.ok) throw new Error('文件不可用或已发生变化。')
  const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
  link.href = url; link.download = path.split('/').at(-1) ?? 'file'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
