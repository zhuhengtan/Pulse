import { PulseButton, PulseDisclosure } from './PulseControls.js'
import { useEffect, useState } from 'react'
import type { QueryPatch } from './routing.js'
import { apiJson, type PulseWebTransport } from './transport.js'

interface Artifact { path: string; label?: string; runId: string; absolutePath: string; workspaceState: 'isolated' | 'project' }

export function ConversationArtifacts({ conversationId, revision, transport, position, onNavigate }: { conversationId: string; revision: string; transport: PulseWebTransport; position?: URLSearchParams; onNavigate?: (patch: QueryPatch) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [preview, setPreview] = useState<{ path: string; content: string }>()
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    setArtifacts([]); setPreview(undefined); setError('')
    void apiJson<Artifact[]>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/artifacts`).then(items => { if (current) setArtifacts(items) }).catch(() => { if (current) setError('交付文件暂时无法读取，请重新打开会话。') })
    return () => { current = false }
  }, [conversationId, revision, transport])
  const artifactPath = position?.get('artifact'), artifactRun = position?.get('artifactRun')
  useEffect(() => {
    if (!position) return
    setPreview(undefined)
    if (!artifactPath || !artifactRun) return
    let current = true
    setError('')
    void apiJson<{ content: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/content?${new URLSearchParams({ path: artifactPath, runId: artifactRun })}`)
      .then(value => { if (current) setPreview({ path: artifactPath, content: value.content }) })
      .catch(() => { if (current) setError('文件不可用或已发生变化，请核对本次工作的文件位置。') })
    return () => { current = false }
  }, [conversationId, artifactPath, artifactRun, transport])
  const read = async (artifact: Artifact, download: boolean) => {
    if (!download && onNavigate) { onNavigate({ artifact: artifact.path, artifactRun: artifact.runId }); return }
    setError('')
    try {
      const value = await apiJson<{ content: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/content?${new URLSearchParams({ path: artifact.path, runId: artifact.runId })}`)
      if (!download) { setPreview({ path: artifact.path, content: value.content }); return }
      const url = URL.createObjectURL(new Blob([value.content], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = artifact.path.split('/').at(-1) ?? 'artifact.txt'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setError('文件不可用或已发生变化，请核对本次工作的文件位置。') }
  }
  if (!artifacts.length && !error && !artifactPath) return null
  return <section className="conversation-artifacts" aria-label="交付文件">
    <strong>交付文件</strong>
    {artifacts.map(artifact => <div key={artifact.path}>
      <span>{artifact.label ?? artifact.path} · {artifact.workspaceState === 'isolated' ? '尚未合入项目' : '已在项目目录'}</span>
      <div className="artifact-location">{artifact.absolutePath}</div>
      <PulseButton type="button" onClick={() => void read(artifact, false)}>查看</PulseButton>{' '}
      <PulseButton type="button" onClick={() => void read(artifact, true)}>下载</PulseButton>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {preview && <PulseDisclosure key={preview.path} defaultOpen label={preview.path} {...(onNavigate ? { open: Boolean(artifactPath), onToggle: (open: boolean) => { if (!open) onNavigate({ artifact: undefined, artifactRun: undefined }) } } : {})}><pre>{preview.content}</pre></PulseDisclosure>}
  </section>
}
