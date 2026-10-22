import { useEffect, useState } from 'react'
import { DiffViewer } from './DiffViewer.js'
import { PulseButton } from './PulseControls.js'
import { apiJson, ApiError, type PulseWebTransport } from './transport.js'
import type { PreviewTarget } from './previewState.js'

export function DiffPreview({ target, transport }: { target: Extract<PreviewTarget, { kind: 'diff' }>; transport: PulseWebTransport }) {
  const [diff, setDiff] = useState<string>(), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    const controller = new AbortController(); setDiff(undefined); setError('')
    const base = target.conversationId ? `/api/conversations/${encodeURIComponent(target.conversationId)}` : `/api/projects/${encodeURIComponent(target.projectId ?? '')}`
    void apiJson<{ diff: string }>(transport, `${base}/git/diff?${new URLSearchParams({ path: target.path, staged: target.staged ? '1' : '0' })}`, { signal: controller.signal })
      .then(value => { if (active) setDiff(value.diff) }).catch(reason => { if (active) setError(reason instanceof ApiError && reason.detail === 'NOT_GIT_REPOSITORY' ? '此目录不是 Git 仓库，无法比较代码变更。' : '差异无法读取，文件或工作目录可能已不可用，或差异超过读取限制。') })
    return () => { active = false; controller.abort() }
  }, [target, transport, revision])
  return <div className="diff-preview"><div className="preview-toolbar"><span className="preview-file-path" title={target.path}>{target.path} · Diff</span><PulseButton onClick={() => setRevision(revision + 1)}>刷新差异</PulseButton></div><p className="diff-basis">{target.staged ? '暂存区 · 相对 HEAD' : '当前工作区 · 相对暂存区'}{target.conversationId ? ' · 使用会话的执行目录' : ''}</p>{error ? <p role="alert" className="preview-error">{error}</p> : diff === undefined ? <p role="status">正在读取差异…</p> : <DiffViewer key={revision} text={diff} />}</div>
}
