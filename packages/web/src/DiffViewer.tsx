import { useMemo, useState } from 'react'
import { PulseButton, PulseSelect } from './PulseControls.js'
import { diffFiles, parseDiff } from './diff.js'
import { MonacoDiff } from './MonacoDiff.js'
import './diff.css'

export function DiffViewer({ text, path }: { text: string; path?: string }) {
  // A new patch resets selection while keeping the user's display preference.
  return <DiffContent key={text} text={text} {...(path ? { path } : {})} />
}

function DiffContent({ text, path }: { text: string; path?: string }) {
  const [mode, setMode] = useState<'unified' | 'split'>(() => { try { return localStorage.getItem('pulse-diff-mode') === 'split' ? 'split' : 'unified' } catch { return 'unified' } })
  const [fileIndex, setFileIndex] = useState(0), [hunkIndex, setHunkIndex] = useState(0), [wrap, setWrap] = useState(false)
  const files = useMemo(() => diffFiles(text, path), [text, path])
  const lines = useMemo(() => parseDiff(text), [text])
  const added = lines.filter(line => line.kind === 'add').length, removed = lines.filter(line => line.kind === 'delete').length
  const file = files[fileIndex], hunk = file?.hunks[hunkIndex]
  const changeMode = (value: 'unified' | 'split') => { setMode(value); try { localStorage.setItem('pulse-diff-mode', value) } catch { /* Optional client preference. */ } }
  return <section className={`diff-viewer diff-${mode}`} aria-label="代码差异">
    <div className="diff-toolbar">
      <div role="group" aria-label="差异显示方式"><PulseButton aria-pressed={mode === 'unified'} onClick={() => changeMode('unified')}>统一视图</PulseButton><PulseButton aria-pressed={mode === 'split'} onClick={() => changeMode('split')}>左右对照</PulseButton></div>
      <PulseButton aria-pressed={wrap} onClick={() => setWrap(!wrap)}>自动换行</PulseButton>
      <span className="diff-stat"><span className="diff-count-add">+{added}</span><span className="diff-count-delete">−{removed}</span></span>
    </div>
    {!text ? <p className="diff-empty">当前比较范围没有差异。已提交的修改或其他比较范围的修改不会显示在这里。</p> : <>
      <div className="diff-file-bar">
        {files.length > 1 ? <PulseSelect aria-label="差异文件" value={String(fileIndex)} onChange={value => { setFileIndex(Number(value)); setHunkIndex(0) }}>{files.map((item, index) => <option key={index} value={String(index)}>{item.path}</option>)}</PulseSelect> : <span className="diff-file-name" title={file?.path}>{file?.path}</span>}
        {!!file?.hunks.length && <div className="diff-hunk-navigation"><PulseButton aria-label="上一个变更片段" disabled={hunkIndex === 0} onClick={() => setHunkIndex(hunkIndex - 1)}>上一处</PulseButton><span>{hunkIndex + 1} / {file.hunks.length}</span><PulseButton aria-label="下一个变更片段" disabled={hunkIndex + 1 === file.hunks.length} onClick={() => setHunkIndex(hunkIndex + 1)}>下一处</PulseButton></div>}
      </div>
      {hunk && file ? <>
        <div className="diff-hunk-caption"><code>{hunk.header}</code><span>变更片段 · 含上下文 · 只读</span></div>
        {mode === 'split' && <div className="diff-side-labels"><span>修改前</span><span>修改后</span></div>}
        <MonacoDiff hunk={hunk} path={file.path} split={mode === 'split'} wrap={wrap} />
      </> : <div className="diff-metadata"><p>此变更没有可对照的文本内容（例如二进制文件、重命名或权限变更）。</p><pre>{file?.metadata.join('\n')}</pre></div>}
    </>}
  </section>
}
