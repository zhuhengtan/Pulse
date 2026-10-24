import { useEffect, useRef, useState } from 'react'
import { Modal, Select } from 'antd'
import { ApiError, apiJson, jsonRequest, type PulseWebTransport, type WebConversation, type WebProject } from './transport.js'
import { PulseButton } from './PulseControls.js'
import { Icon } from './Icon.js'

interface Preview {
  token: string; conversationId: string; title: string; runCount: number; attachmentCount: number
  activeRunId?: string; blockedReasons: string[]; redactedFiles: number; expiresAt: string
}
interface ImportResult { conversation: WebConversation; blockedReasons: string[]; duplicate: boolean }
const labels: Record<string, string> = {
  CONVERSATION_BUSY: '会话仍在运行，请等待任务完成或中断后再导出。',
  BUNDLE_TOO_LARGE: '压缩包超过限制（ZIP 256 MiB、解压后 1 GiB）。',
  BUNDLE_TOO_MANY_FILES: '文件数量超过 20,000 个。',
  BUNDLE_INVALID_ARCHIVE: '压缩包损坏，或不是受支持的 Pulse 工作会话包。',
  BUNDLE_INVALID_ZIP: 'ZIP 文件损坏或格式不受支持。',
  BUNDLE_INVALID_PATH: '压缩包包含不安全的文件路径。',
  BUNDLE_INVALID_ENTRY: '压缩包包含重复、加密或非普通文件条目。',
  BUNDLE_INVALID_MANIFEST: '压缩包清单无效。',
  BUNDLE_HASH_MISMATCH: '文件校验失败，压缩包可能损坏或被修改。',
  BUNDLE_FILE_LIST_MISMATCH: '文件列表与清单不一致。',
  BUNDLE_SYMLINK_FORBIDDEN: '会话目录含符号链接，不能安全导出。',
  BUNDLE_ID_CONFLICT: '目标机已有同 ID 会话，已拒绝覆盖。',
  BUNDLE_RUN_ID_CONFLICT: '目标机已有同 ID 运行记录，已拒绝覆盖。',
  BUNDLE_IMPORT_BUSY: '正在处理其他导入，请稍后重试。',
  BUNDLE_IMPORT_EXPIRED: '导入预览已过期，请重新选择压缩包。',
  PROJECT_NOT_AVAILABLE: '目标项目不可用，请选择本机已有项目。',
  WORK_SESSION_REQUIRED: '只支持工作会话。',
  RECOVERY_BUILD_INCOMPATIBLE: 'Pulse 构建不同，请在目标机使用与源机器相同的构建。',
  RECOVERY_POLICY_INCOMPATIBLE: '两台机器的权限或网络策略不同。',
  RECOVERY_MODEL_UNAVAILABLE: '目标机缺少原任务使用的模型配置。',
  RECOVERY_MANUAL_APPROVAL_REQUIRED: '跨机恢复需要目标机使用逐项审批模式。',
  RECOVERY_SNAPSHOT_INCOMPLETE: '恢复快照或外置数据不完整。',
  RECOVERY_TASK_ALREADY_FINISHED: '快照中的任务已结束，可以查看记录或发送新消息。',
  RECOVERY_SNAPSHOT_MISSING: '缺少恢复快照。',
  RECOVERY_SIDE_EFFECT_UNKNOWN: '存在执行结果未知的工具操作，不能自动重试。',
  RECOVERY_MACHINE_RESOURCE_REQUIRED: '未完成操作依赖源机器的浏览器、桌面或终端。',
  RECOVERY_APPROVAL_RECONFIRM_REQUIRED: '源机器已审批但尚未执行的操作不能迁移授权，请在源机器回到待审批断点后重新导出。',
  RECOVERY_PENDING_AUTHORIZATION: '快照包含尚未处理的授权答复。',
  RECOVERY_PATH_NOT_PORTABLE: '待执行操作含无法安全迁移的机器路径。',
  RECOVERY_DATA_REDACTED: '恢复状态中的敏感信息已脱敏，只能用于查看和调试。',
  WORKSPACE_FINGERPRINT_UNAVAILABLE: '无法完整计算项目文件指纹，不能确认断点一致。',
  WORKSPACE_CHANGED_DURING_EXPORT: '导出期间项目文件发生变化，请重新导出。',
  WORKSPACE_CONTENT_MISMATCH: '目标项目文件与源机器执行目录不一致，请先同步项目。',
}
export function transferReason(reason: string): string { return labels[reason] ?? reason }
export function transferError(error: unknown): string {
  if (error instanceof ApiError && error.detail) return error.detail.split(';').map(transferReason).join('；')
  return '操作失败，请检查连接后重试；原会话已保留。'
}

export function useConversationTransfer({ transport, selected, projects, unavailable, onImported, notice }: {
  transport: PulseWebTransport; selected: WebConversation | undefined; projects: WebProject[]
  unavailable: boolean; onImported: (conversation: WebConversation) => void; notice: (text: string) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [exporting, setExporting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<Preview>()
  const [projectId, setProjectId] = useState<string>()
  const [checking, setChecking] = useState(false)
  const [reasons, setReasons] = useState<string[]>([])
  const [error, setError] = useState('')
  const [checkedProject, setCheckedProject] = useState<string>()
  const transferRef = useRef({ transport, preview })
  transferRef.current = { transport, preview }
  useEffect(() => () => {
    const { transport, preview } = transferRef.current
    if (preview) void transport.request(`/api/conversation-imports/${preview.token}`, { method: 'DELETE' }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!preview || !projectId) return
    let current = true
    setChecking(true); setCheckedProject(undefined); setError('')
    void apiJson<{ blockedReasons: string[] }>(transport, `/api/conversation-imports/${preview.token}`, jsonRequest('POST', { projectId, preview: true })).then(result => {
      if (current) { setReasons(result.blockedReasons); setCheckedProject(projectId) }
    }).catch(error => { if (current) setError(transferError(error)) }).finally(() => { if (current) setChecking(false) })
    return () => { current = false }
  }, [transport, preview, projectId])

  async function download() {
    if (!selected || unavailable || exporting) return
    const conversation = selected
    setExporting(true)
    try {
      const response = await transport.request(`/api/conversations/${encodeURIComponent(conversation.id)}/export`, { method: 'POST' })
      if (!response.ok) { let detail: string | undefined; try { detail = (await response.json() as { error: string }).error } catch { /* Non-JSON response. */ } throw new ApiError(response.status, detail) }
      const blob = await response.blob()
      const filename = response.headers.get('content-disposition')?.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] ?? `pulse-${conversation.id}.zip`
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      notice('会话压缩包已交给浏览器下载。')
    } catch (error) { notice(transferError(error)) }
    finally { setExporting(false) }
  }
  async function upload(file: File) {
    if (uploading || importing) return
    if (file.size > 256 * 1024 * 1024) { notice(labels.BUNDLE_TOO_LARGE!); return }
    setUploading(true); setError('')
    try {
      const result = await apiJson<Preview>(transport, '/api/conversation-imports', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file })
      setPreview(result); setReasons(result.blockedReasons); setProjectId(undefined); setCheckedProject(undefined)
    } catch (error) { notice(transferError(error)) }
    finally { setUploading(false) }
  }
  async function cancel() {
    if (!preview || importing) return
    const token = preview.token
    setPreview(undefined); setError(''); setProjectId(undefined); setChecking(false)
    try { await transport.request(`/api/conversation-imports/${token}`, { method: 'DELETE' }) } catch { /* Server TTL removes disconnected uploads. */ }
  }
  async function commit() {
    if (!preview || !projectId || checking || importing || checkedProject !== projectId) return
    setImporting(true); setError('')
    try {
      const result = await apiJson<ImportResult>(transport, `/api/conversation-imports/${preview.token}`, jsonRequest('POST', { projectId }))
      setPreview(undefined)
      onImported(result.conversation)
      notice(result.duplicate ? '此压缩包已导入，已打开原会话。' : result.blockedReasons.length ? `会话已导入，原任务暂不能恢复：${result.blockedReasons.map(transferReason).join('；')}` : result.conversation.activeRunId ? '会话已导入；可查看记录，或点击“继续任务”恢复断点。' : '会话已导入，可查看历史或继续发送新消息。')
    } catch (error) { setError(transferError(error)) }
    finally { setImporting(false) }
  }
  return {
    exportItem: { key: 'export', label: exporting ? '导出中…' : '导出会话', icon: <Icon name="download"/>, disabled: !selected || unavailable || exporting, title: unavailable ? '运行中或正在加载，请等待任务完成或中断后再导出' : '导出当前工作会话为 ZIP', onClick: () => void download() },
    exportButton: <PulseButton className="details-button transfer-export" disabled={!selected || unavailable || exporting} aria-label="导出会话" title={unavailable ? '运行中或正在加载，请等待任务完成或中断后再导出' : '导出当前工作会话为 ZIP'} onClick={() => void download()}><Icon name="download"/><span>{exporting ? '导出中…' : '导出'}</span></PulseButton>,
    importButton: <PulseButton className="transfer-import" disabled={uploading || importing || Boolean(preview)} aria-label="导入会话" onClick={() => fileInput.current?.click()}><Icon name="upload"/><span>{uploading ? '检查压缩包…' : '导入会话'}</span></PulseButton>,
    dialog: <>
      <input ref={fileInput} type="file" accept=".zip,application/zip" hidden aria-label="选择会话压缩包" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file) }}/>
      <Modal title="导入工作会话" open={Boolean(preview)} onCancel={() => void cancel()} mask={{ closable: !importing }} closable={!importing} destroyOnHidden footer={<><PulseButton disabled={importing} onClick={() => void cancel()}>取消</PulseButton><PulseButton disabled={importing || checking || !projectId || checkedProject !== projectId} onClick={() => void commit()}>{importing ? '导入中…' : '导入并查看'}</PulseButton></>}>
        {preview && <div className="conversation-transfer-form">
          <strong>{preview.title}</strong><p>{preview.runCount} 次运行 · {preview.attachmentCount} 个附件{preview.redactedFiles > 0 ? ` · ${preview.redactedFiles} 个文件已脱敏` : ''}</p>
          <p>压缩包不包含项目源码。请选择已同步到本机的项目；导入后不会自动执行任务。</p>
          <label htmlFor="transfer-project">目标项目</label>
          <Select id="transfer-project" aria-label="目标项目" placeholder="选择已同步的目标项目" value={projectId} onChange={setProjectId} disabled={importing} options={projects.filter(project => project.available).map(project => ({ value: project.id, label: project.name }))}/>
          {!projects.some(project => project.available) && <p role="status">请先在历史会话栏添加本机已有项目。</p>}
          {checking && <p role="status">正在检查恢复兼容性和项目文件…</p>}
          {!checking && reasons.length > 0 && <div role="status"><strong>资料可以导入，原任务恢复受阻：</strong><ul>{reasons.map(reason => <li key={reason}>{transferReason(reason)}</li>)}</ul></div>}
          {!checking && projectId && checkedProject === projectId && reasons.length === 0 && <p role="status">{preview.activeRunId ? '检查通过。导入后可手动继续任务；执行前仍会复查工具契约和项目状态。' : '检查通过。导入后可查看历史或继续发送新消息。'}</p>}
          {error && <p role="alert">{error}</p>}
        </div>}
      </Modal>
    </>,
  }
}
