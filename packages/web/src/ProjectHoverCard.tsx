import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Popover } from 'antd'
import { Icon } from './Icon.js'
import { PulseButton } from './PulseControls.js'
import type { WebProject } from './transport.js'
import './project-hover-card.css'

export function ProjectHoverCard({ project, count, disabled, onPin, onEdit, children }: {
  project: WebProject; count: number; disabled: boolean; onPin: () => Promise<unknown>; onEdit: () => void; children: ReactNode
}) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false)
  const pinLock = useRef(false)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <Popover placement="rightTop" trigger={['hover', 'focus']} mouseEnterDelay={0.45} mouseLeaveDelay={0.18} open={open && !disabled} onOpenChange={setOpen} classNames={{ root: 'project-info-popover' }} content={
    <section className="project-info-card" aria-label={`项目信息：${project.name}`}>
      <header><Icon name="folder-open" size={20}/><strong>{project.name}</strong><PulseButton type="button" className="project-info-pin" disabled={saving} aria-label={project.pinned ? '取消置顶项目' : '置顶项目'} aria-pressed={project.pinned} title={project.pinned ? '取消置顶' : '置顶'} onClick={async event => {
        event.stopPropagation(); if (pinLock.current) return
        pinLock.current = true; setSaving(true)
        try { await onPin() } finally { pinLock.current = false; setSaving(false) }
      }}><Icon name="pin" size={18}/></PulseButton></header>
      <p className="project-info-count"><Icon name="message" size={17}/><span>{count} 次聊天</span></p>
      <div className="project-info-folders" aria-label="项目文件夹">
        {(project.folders ?? [project.cwd]).map(path => <div key={path} className="project-info-folder"><Icon name="folder" size={17}/><span title={path}>{path}</span>{path === project.cwd && <small>主要</small>}</div>)}
      </div>
      {!project.available && <p className="project-info-unavailable">主文件夹暂不可用</p>}
      <footer><PulseButton type="button" onClick={event => { event.stopPropagation(); setOpen(false); onEdit() }}><Icon name="settings" size={16}/>编辑项目</PulseButton></footer>
    </section>
  }><div className="project-hover-target">{children}</div></Popover>
}
