import { downloadPreview } from './previewState.js'
import { PulseButton, PulseDisclosure } from './PulseControls.js'
import { useEffect, useState } from 'react'
import type { QueryPatch } from './routing.js'
import { apiJson, type PulseWebTransport } from './transport.js'

export interface ConversationArtifact { path: string; label?: string; runId: string; absolutePath: string; workspaceState: 'isolated' | 'project' }
const emptyArtifacts: ConversationArtifact[] = []

/** Fetch once per conversation revision; individual turns only render their own entries. */
export function useConversationArtifacts(conversationId: string | undefined, revision: string, transport: PulseWebTransport) {
  const [result, setResult] = useState<{ conversationId: string; artifacts: ConversationArtifact[]; error: string }>()
  useEffect(() => {
    if (!conversationId) return
    let current = true
    void apiJson<ConversationArtifact[]>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/artifacts?scope=turn`)
      .then(artifacts => { if (current) setResult({ conversationId, artifacts, error: '' }) })
      .catch(() => { if (current) setResult(previous => ({ conversationId, artifacts: previous?.conversationId === conversationId ? previous.artifacts : emptyArtifacts, error: '交付文件暂时无法读取，请重新打开会话。' })) })
    return () => { current = false }
  }, [conversationId, revision, transport])
  return result && result.conversationId === conversationId ? result : { artifacts: emptyArtifacts, error: '' }
}

export function ConversationArtifacts({ conversationId, runId, artifacts, transport, position, onNavigate }: { conversationId: string; runId: string; artifacts: ConversationArtifact[]; transport: PulseWebTransport; position?: URLSearchParams; onNavigate?: (patch: QueryPatch) => void }) {
  const [preview, setPreview] = useState<{ path: string; content: string }>()
  const [error, setError] = useState('')
  const artifactPath = position?.get('artifactRun') === runId ? position.get('artifact') : undefined
  useEffect(() => {
    if (!position) return
    setPreview(undefined); setError('')
    if (!artifactPath || onNavigate && position.get('workspace') === 'preview') return
    let current = true
    void apiJson<{ content: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/content?${new URLSearchParams({ path: artifactPath, runId })}`)
      .then(value => { if (current) setPreview({ path: artifactPath, content: value.content }) })
      .catch(() => { if (current) setError('文件不可用或已发生变化，请核对本次工作的文件位置。') })
    return () => { current = false }
  }, [conversationId, artifactPath, runId, transport])
  const read = async (artifact: ConversationArtifact, download: boolean) => {
    if (!download && onNavigate) { onNavigate({ workspace: 'preview', diff: undefined, artifact: artifact.path, artifactRun: artifact.runId, file: undefined, automation: undefined }); return }
    setError('')
    try {
      if (download) { await downloadPreview(await transport.request(`/api/conversations/${encodeURIComponent(conversationId)}/artifacts/raw?${new URLSearchParams({ path: artifact.path, runId: artifact.runId, download: '1' })}`), artifact.path); return }
      const value = await apiJson<{ content: string }>(transport, `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/content?${new URLSearchParams({ path: artifact.path, runId: artifact.runId })}`)
      setPreview({ path: artifact.path, content: value.content })
    } catch { setError('文件不可用或已发生变化，请核对本次工作的文件位置。') }
  }
  if (!artifacts.length && !error && !artifactPath) return null
  return <section className="conversation-artifacts" aria-label="本轮交付文件" data-run-id={runId}>
    <strong className="artifact-heading">本轮交付{artifacts.length > 0 && <span>{artifacts.length}</span>}</strong>
    {artifacts.map(artifact => <div className="artifact-row" key={`${artifact.runId}:${artifact.path}`}>
      <div className="artifact-info">
        <span className="artifact-name" title={artifact.path}>{artifact.label ?? artifact.path}</span>
        <details className="artifact-details"><summary>{artifact.workspaceState === 'isolated' ? '尚未合入项目' : '已在项目目录'}<span> · 位置</span></summary><div className="artifact-location">{artifact.absolutePath}</div></details>
      </div>
      <div className="artifact-actions"><PulseButton type="button" onClick={() => void read(artifact, false)}>查看</PulseButton><PulseButton type="button" onClick={() => void read(artifact, true)}>下载</PulseButton></div>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {preview && <PulseDisclosure key={preview.path} defaultOpen label={preview.path} {...(onNavigate ? { open: Boolean(artifactPath), onToggle: (open: boolean) => { if (!open) onNavigate({ artifact: undefined, artifactRun: undefined }) } } : {})}><pre>{preview.content}</pre></PulseDisclosure>}
  </section>
}
