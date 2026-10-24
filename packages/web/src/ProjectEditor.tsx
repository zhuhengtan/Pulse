import { useState } from 'react'
import { Modal } from 'antd'
import { HostPathPicker } from './HostPathPicker.js'
import { PulseButton, PulseInput } from './PulseControls.js'
import { Icon } from './Icon.js'
import { ApiError, apiJson, jsonRequest, type PulseWebTransport, type WebProject } from './transport.js'
import './project-editor.css'

export function ProjectEditor({ project, transport, canEditFolders, onSaved, onClose, onRemove }: {
  project: WebProject; transport: PulseWebTransport; canEditFolders: boolean
  onSaved: (project: WebProject) => void; onClose: () => void; onRemove: () => Promise<void>
}) {
  const [name, setName] = useState(project.name)
  const [folders, setFolders] = useState(() => [...new Set(project.folders ?? [project.cwd])])
  const [primary, setPrimary] = useState(project.cwd)
  const [picker, setPicker] = useState<number | 'add'>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setError('')
    try {
      const changedFolders = primary !== project.cwd || JSON.stringify(folders) !== JSON.stringify(project.folders ?? [project.cwd])
      const updated = await apiJson<WebProject>(transport, `/api/projects/${encodeURIComponent(project.id)}`, jsonRequest('PATCH', { name: name.trim(), ...(changedFolders ? { folders, cwd: primary } : {}) }))
      onSaved(updated); onClose()
    } catch (failure) {
      setError(failure instanceof ApiError && failure.detail === 'PROJECT_ALREADY_REGISTERED' ? '主文件夹已作为其他项目登记，请选择其他文件夹。' : '保存失败，请确认文件夹仍然存在且可以访问。')
    } finally { setBusy(false) }
  }
  const removeFolder = (path: string) => {
    const next = folders.filter(item => item !== path)
    if (!next.length) return
    setFolders(next); if (primary === path) setPrimary(next[0]!)
  }
  return <>
    <Modal open title="编辑项目" className="project-editor" width={580} onCancel={() => { if (!busy) onClose() }} mask={{ closable: !busy }} closable={!busy} footer={<div className="project-editor-footer">
      <PulseButton className="project-editor-remove" disabled={busy} onClick={() => void onRemove()}>移除本地项目</PulseButton>
      <span/><PulseButton disabled={busy} onClick={onClose}>取消</PulseButton><PulseButton className="project-editor-save" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</PulseButton>
    </div>}>
      <form onSubmit={event => { event.preventDefault(); void save() }}>
        <PulseInput className="project-name-field" autoFocus prefix={<Icon name="folder"/>} aria-label="项目名称" value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)}/>
        <h3>源文件夹</h3>
        <div className="project-source-folders" role="list" aria-label="源文件夹">
          {folders.map((path, index) => <div key={path} className="project-source-folder" role="listitem">
            <PulseButton type="button" className="project-source-path" title={path} disabled={busy || !canEditFolders} aria-label={`编辑文件夹：${path}`} onClick={() => setPicker(index)}><Icon name="folder"/><span><strong>{path.split(/[\\/]/).filter(Boolean).at(-1) ?? path}</strong><small>{path}</small></span></PulseButton>
            <PulseButton type="button" className={`project-source-primary ${path === primary ? 'is-primary' : ''}`} disabled={busy || !canEditFolders} aria-pressed={path === primary} aria-label={`设为主文件夹：${path}`} onClick={() => setPrimary(path)}>{path === primary ? '主要' : '设为主要'}</PulseButton>
            <PulseButton type="button" className="project-source-remove" title={folders.length === 1 ? '至少保留一个源文件夹' : '移除此源文件夹'} disabled={busy || !canEditFolders || folders.length === 1} aria-label={`移除文件夹：${path}`} onClick={() => removeFolder(path)}><Icon name="close" size={15}/></PulseButton>
          </div>)}
          <PulseButton type="button" className="project-source-add" disabled={busy || !canEditFolders || folders.length >= 16} onClick={() => setPicker('add')}><Icon name="folder-add"/>添加文件夹</PulseButton>
        </div>
        <p className="project-primary-hint">主文件夹作为新会话的默认工作目录；已有会话保留当前执行目录。</p>
        {error && <p role="alert" className="project-editor-error">{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1}/>
      </form>
    </Modal>
    <HostPathPicker open={picker !== undefined} mode="directory" {...(typeof picker === 'number' ? { initialPath: folders[picker]! } : {})} transport={transport} onCancel={() => setPicker(undefined)} onConfirm={({ path }) => {
      if (picker === undefined) return
      if (folders.includes(path) && !(typeof picker === 'number' && folders[picker] === path)) { setError('此文件夹已在项目中。'); setPicker(undefined); return }
      const previous = typeof picker === 'number' ? folders[picker] : undefined
      setFolders(items => picker === 'add' ? [...items, path] : items.map((item, index) => index === picker ? path : item))
      if (previous === primary) setPrimary(path)
      setError(''); setPicker(undefined)
    }}/>
  </>
}
