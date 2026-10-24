import { useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor'
import type { DiffHunk } from './diff.js'

export function MonacoDiff({ hunk, path, split, wrap }: { hunk: DiffHunk; path: string; split: boolean; wrap: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneDiffEditor | undefined>(undefined)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const latest = useRef({ split, wrap }); latest.current = { split, wrap }

  useEffect(() => {
    let disposed = false
    const resources: { dispose(): void }[] = []
    const release = () => {
      if (instance.current && resources.includes(instance.current)) instance.current = undefined
      resources.splice(0).forEach(resource => resource.dispose())
    }
    setStatus('loading')
    void import('./monaco.js').then(({ monaco }) => {
      if (disposed || !container.current) return
      const name = path.split('/').at(-1) ?? path
      const language = monaco.languages.getLanguages().find(item => item.filenames?.includes(name) || item.extensions?.some(ext => name.endsWith(ext)))?.id ?? 'plaintext'
      const original = monaco.editor.createModel(hunk.original, language)
      const modified = monaco.editor.createModel(hunk.modified, language)
      resources.push(original, modified)
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const syncTheme = () => {
        const theme = document.documentElement.dataset.theme ?? 'system'
        monaco.editor.setTheme(theme === 'dark' || (theme === 'system' && media.matches) ? 'vs-dark' : 'vs')
      }
      syncTheme()
      const diff = monaco.editor.createDiffEditor(container.current, {
        automaticLayout: true, readOnly: true, originalEditable: false,
        renderSideBySide: latest.current.split, useInlineViewWhenSpaceIsLimited: false,
        wordWrap: latest.current.wrap ? 'on' : 'off', diffWordWrap: latest.current.wrap ? 'on' : 'off',
        ignoreTrimWhitespace: false, renderIndicators: true, renderOverviewRuler: true,
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12, lineHeight: 20,
        padding: { top: 12, bottom: 12 }, lineNumbersMinChars: 3,
        folding: false, glyphMargin: false, contextmenu: false, links: false,
        stickyScroll: { enabled: false }, domReadOnly: true, renderValidationDecorations: 'off',
        originalAriaLabel: `${path} 修改前`, modifiedAriaLabel: `${path} 修改后`,
      })
      resources.unshift(diff)
      diff.setModel({ original, modified })
      const sourceLineNumber = (text: string, start: number) => {
        const count = text ? text.split('\n').length - Number(text.endsWith('\n')) : 0
        return (line: number) => line <= count ? String(start + line - 1) : ''
      }
      diff.getOriginalEditor().updateOptions({ lineNumbers: sourceLineNumber(hunk.original, hunk.oldStart) })
      diff.getModifiedEditor().updateOptions({ lineNumbers: sourceLineNumber(hunk.modified, hunk.newStart) })
      instance.current = diff
      const observer = new MutationObserver(syncTheme)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      media.addEventListener('change', syncTheme)
      resources.unshift({ dispose: () => {
        observer.disconnect(); media.removeEventListener('change', syncTheme)
      } })
      setStatus('ready')
    }).catch(() => { release(); if (!disposed) setStatus('error') })
    return () => { disposed = true; release() }
  }, [hunk, path])

  useEffect(() => {
    instance.current?.updateOptions({ renderSideBySide: split, wordWrap: wrap ? 'on' : 'off', diffWordWrap: wrap ? 'on' : 'off' })
  }, [split, wrap])

  return <div className="monaco-diff-shell">
    <div ref={container} className="monaco-diff-container" />
    {status === 'loading' && <p role="status" className="monaco-diff-status">正在加载差异编辑器…</p>}
    {status === 'error' && <div role="alert" className="monaco-diff-fallback"><p>差异编辑器加载失败，以下为当前片段的文本。</p><strong>修改前</strong><pre>{hunk.original}</pre><strong>修改后</strong><pre>{hunk.modified}</pre></div>}
  </div>
}
