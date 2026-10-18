import { useEffect, useRef, useState } from 'react'
import { Breadcrumb, Modal } from 'antd'
import type { HostPathEntry, HostPathListing, HostPathMode, HostPathRoots } from '@hunterzhu/pulse-server/protocol'
import { ApiError, apiJson, jsonRequest, type PulseWebTransport } from './transport.js'
import { PulseButton, PulseCheckbox, PulseInput } from './PulseControls.js'
import { Icon } from './Icon.js'
import './host-path-picker.css'

export interface HostPathPickerProps {
  open: boolean
  mode: HostPathMode
  initialPath?: string
  allowCreateDirectory?: boolean
  transport: PulseWebTransport
  onConfirm: (selection: { path: string; kind: 'file' | 'directory' }) => void
  onCancel: () => void
}
function failureMessage(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      HOST_PATH_FORBIDDEN: '电脑不允许访问此目录，请选择其他目录。',
      HOST_PATH_NOT_FOUND: '路径已不存在或链接已失效，请重新选择。',
      HOST_DIRECTORY_REQUIRED: '请输入电脑上的文件夹路径。',
      HOST_ABSOLUTE_PATH_REQUIRED: '请输入运行 Pulse 的电脑上的绝对路径。',
      HOST_PATH_EXISTS: '已有同名文件或文件夹，请使用其他名称。',
      HOST_DIRECTORY_NAME_INVALID: '文件夹名称无效，请勿使用路径分隔符或保留名称。',
      SAME_ORIGIN_REQUIRED: '请求来源验证失败，请从 Pulse 页面重试。',
    }
    if (error.status === 401) return '设备授权已失效，请重新配对。'
    if (error.detail && messages[error.detail]) return messages[error.detail]!
    if (error.status === 404) return '电脑路径服务不可用，请更新运行 Pulse 的服务。'
  }
  return '无法读取电脑目录，请检查连接后重试。'
}
/** Browses the host filesystem; this never opens the phone's native file chooser. */
export function HostPathPicker({ open, mode, initialPath, allowCreateDirectory = false, transport, onConfirm, onCancel }: HostPathPickerProps) {
  const [roots, setRoots] = useState<HostPathRoots>()
  const [listing, setListing] = useState<HostPathListing>()
  const [pathInput, setPathInput] = useState('')
  const [hidden, setHidden] = useState(false)
  const [selected, setSelected] = useState<HostPathEntry>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [initialization, setInitialization] = useState(0)
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')
  const sequence = useRef(0)
  const pending = useRef<AbortController | undefined>(undefined)
  const lastPath = useRef('')
  const latest = useRef({ open, hidden }); latest.current = { open, hidden }
  function begin() {
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    return { id: ++sequence.current, controller }
  }
  const current = (id: number) => latest.current.open && sequence.current === id
  async function load(path: string, showHidden = hidden, offset = 0) {
    const { id, controller } = begin()
    lastPath.current = path
    setBusy(true); setError(''); setSelected(undefined)
    if (!offset) { setListing(undefined); setPathInput(path) }
    try {
      const query = new URLSearchParams({ path, mode, hidden: showHidden ? '1' : '0', offset: String(offset) })
      const page = await apiJson<HostPathListing>(transport, `/api/host-filesystem/entries?${query}`, { signal: controller.signal })
      if (!current(id)) return
      setListing(previous => offset && previous?.path === page.path ? { ...page, entries: [...previous.entries, ...page.entries] } : page)
      setPathInput(page.path); lastPath.current = page.path
    } catch (failure) { if (current(id)) setError(failureMessage(failure)) }
    finally { if (current(id)) setBusy(false) }
  }
  useEffect(() => {
    if (!open) return
    const { id, controller } = begin()
    lastPath.current = initialPath ?? ''
    setRoots(undefined); setListing(undefined); setSelected(undefined); setError(''); setBusy(true); setCreating(false); setFolderName(''); setHidden(false)
    void apiJson<HostPathRoots>(transport, '/api/host-filesystem/roots', { signal: controller.signal }).then(value => {
      if (!current(id)) return
      setRoots(value); void load(initialPath || value.home, false)
    }).catch(failure => { if (current(id)) { setError(failureMessage(failure)); setBusy(false) } })
    return () => { ++sequence.current; pending.current?.abort() }
  }, [open, initialPath, mode, transport, initialization])
  async function createDirectory() {
    if (!listing || busy || !folderName.trim()) return
    const { id, controller } = begin()
    setBusy(true); setError('')
    try {
      const created = await apiJson<{ path: string }>(transport, '/api/host-filesystem/directories', { ...jsonRequest('POST', { parentPath: listing.path, name: folderName }), signal: controller.signal })
      if (!current(id)) return
      setCreating(false); setFolderName(''); await load(created.path)
    } catch (failure) { if (current(id)) { setError(failureMessage(failure)); setBusy(false) } }
  }
  const choice = selected ?? (listing && mode !== 'file' ? { path: listing.path, kind: 'directory' as const } : undefined)
  const cancel = () => { ++sequence.current; pending.current?.abort(); onCancel() }
  return <Modal open={open} onCancel={cancel} title={mode === 'directory' ? '选择电脑文件夹' : mode === 'file' ? '选择电脑文件' : '选择电脑文件或文件夹'} className="host-path-picker" width={680} footer={<><PulseButton type="button" onClick={cancel}>取消</PulseButton><PulseButton type="button" className="primary" disabled={busy || !choice || creating} onClick={() => { if (choice) onConfirm({ path: choice.path, kind: choice.kind }) }}>选择{choice?.kind === 'file' ? '文件' : '此文件夹'}</PulseButton></>} destroyOnHidden>
    <p className="host-path-hint">浏览运行 Pulse 的电脑上的路径。</p>
    <div className="host-path-roots"><PulseButton type="button" disabled={!roots || busy} onClick={() => roots && void load(roots.home)}>主目录</PulseButton>{roots?.roots.map(root => <PulseButton type="button" key={root.path} disabled={busy} onClick={() => void load(root.path)}>{root.name}</PulseButton>)}</div>
    <form className="host-path-address" onSubmit={event => { event.preventDefault(); void load(pathInput) }}><PulseInput aria-label="电脑绝对路径" value={pathInput} onChange={event => setPathInput(event.target.value)} /><PulseButton type="submit" disabled={busy || !pathInput}>前往</PulseButton></form>
    <Breadcrumb className="path-breadcrumb" items={listing?.breadcrumbs.map(crumb => ({ key: crumb.path, title: <PulseButton type="button" disabled={busy} onClick={() => void load(crumb.path)}>{crumb.name}</PulseButton> })) ?? []} />
    <div className="host-path-toolbar"><PulseButton type="button" disabled={busy || !listing?.parent} onClick={() => listing?.parent && void load(listing.parent)}>上一级</PulseButton><PulseCheckbox checked={hidden} disabled={busy} onChange={event => { setHidden(event.target.checked); if (lastPath.current) void load(lastPath.current, event.target.checked) }}>显示隐藏项</PulseCheckbox>{allowCreateDirectory && <PulseButton type="button" disabled={busy || !listing} onClick={() => setCreating(value => !value)}>新建文件夹</PulseButton>}</div>
    {creating && <form className="host-path-create" onSubmit={event => { event.preventDefault(); void createDirectory() }}><PulseInput autoFocus aria-label="新文件夹名称" value={folderName} onChange={event => setFolderName(event.target.value)} placeholder="文件夹名称" /><PulseButton type="submit" disabled={busy || !folderName.trim()}>创建</PulseButton><PulseButton type="button" disabled={busy} onClick={() => setCreating(false)}>取消创建</PulseButton></form>}
    {error && <div role="alert" className="host-path-error">{error}<PulseButton type="button" disabled={busy} onClick={() => { if (roots && lastPath.current) void load(lastPath.current); else setInitialization(value => value + 1) }}>重试</PulseButton></div>}
    <div className="host-path-entries" role="list" aria-label="电脑目录内容" aria-busy={busy}>
      {listing?.entries.map(entry => <div role="listitem" key={`${entry.name}:${entry.path}`}><PulseButton type="button" className={`host-path-entry ${selected?.path === entry.path ? 'selected' : ''}`} aria-label={`${entry.kind === 'directory' ? '打开文件夹' : '选择文件'}：${entry.name}${entry.unavailable ? '（不可用）' : ''}`} disabled={busy || Boolean(entry.unavailable)} title={entry.unavailable ? '无法读取或链接已失效' : entry.path} onClick={() => { if (entry.kind === 'directory') { setCreating(false); void load(entry.path) } else setSelected(entry) }}><Icon name={entry.kind === 'directory' ? 'folder' : 'file'} /><span>{entry.name}{entry.symlink ? ' ↗' : ''}</span></PulseButton></div>)}
      {busy && <p role="status">正在读取…</p>}{!busy && listing?.entries.length === 0 && <p>此目录没有可选{mode === 'directory' ? '文件夹' : '文件'}。</p>}
      {listing?.nextOffset != null && <PulseButton type="button" disabled={busy} onClick={() => void load(listing.path, hidden, listing.nextOffset!)}>加载更多</PulseButton>}
    </div>
    <p className="host-path-selection">{selected ? `已选择：${selected.name}` : listing ? `当前文件夹：${listing.path}` : ''}</p>
  </Modal>
}
