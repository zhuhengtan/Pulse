import { useMemo, useState } from 'react'
import { PulseButton } from './PulseControls.js'
import { parseDiff, splitDiff, type DiffLine } from './diff.js'
const PAGE_SIZE = 500
const marker = (line: DiffLine) => line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '

export function DiffViewer({ text }: { text: string }) {
  const [mode, setMode] = useState<'unified' | 'split'>(() => { try { return localStorage.getItem('pulse-diff-mode') === 'split' ? 'split' : 'unified' } catch { return 'unified' } })
  const [page, setPage] = useState(0)
  const lines = useMemo(() => parseDiff(text), [text]), pairs = useMemo(() => splitDiff(lines), [lines])
  const added = lines.filter(line => line.kind === 'add').length, removed = lines.filter(line => line.kind === 'delete').length
  const count = mode === 'split' ? pairs.length : lines.length, pages = Math.max(1, Math.ceil(count / PAGE_SIZE)), currentPage = Math.min(page, pages - 1), start = currentPage * PAGE_SIZE
  const changeMode = (value: 'unified' | 'split') => { setMode(value); setPage(0); try { localStorage.setItem('pulse-diff-mode', value) } catch { /* Optional client preference. */ } }
  return <section className={`diff-viewer diff-${mode}`} aria-label="代码差异">
    <div className="diff-toolbar"><div role="group" aria-label="差异显示方式"><PulseButton type="button" aria-pressed={mode === 'unified'} onClick={() => changeMode('unified')}>统一视图</PulseButton><PulseButton type="button" aria-pressed={mode === 'split'} onClick={() => changeMode('split')}>左右对照</PulseButton></div><span className="diff-stat"><span className="diff-count-add">+{added}</span><span className="diff-count-delete">−{removed}</span></span></div>
    {!text ? <p className="diff-empty">当前比较范围没有差异。已提交的修改或其他比较范围的修改不会显示在这里。</p> : <div className="diff-scroll" tabIndex={0} aria-label="可滚动代码差异"><table className="diff-table"><thead>{mode === 'split' ? <tr><th colSpan={2}>修改前</th><th colSpan={2}>修改后</th></tr> : <tr><th>旧行号</th><th>新行号</th><th aria-label="增删标记"/><th>代码</th></tr>}</thead><tbody>
      {mode === 'unified' ? lines.slice(start, start + PAGE_SIZE).map((line, index) => line.kind === 'meta' ? <tr key={start + index} className="diff-meta"><td colSpan={4}>{line.text}</td></tr> : <tr key={start + index} className={`diff-line diff-line-${line.kind}`}><td className="diff-number">{line.oldLine}</td><td className="diff-number">{line.newLine}</td><td className="diff-marker" aria-label={line.kind === 'add' ? '新增' : line.kind === 'delete' ? '删除' : '上下文'}>{marker(line)}</td><td className="diff-code">{line.text}</td></tr>) : pairs.slice(start, start + PAGE_SIZE).map((row, index) => row.kind === 'meta' ? <tr key={start + index} className="diff-meta"><td colSpan={4}>{row.text}</td></tr> : <tr key={start + index}><td className={`diff-number diff-line-${row.left?.kind ?? 'blank'}`}>{row.left?.oldLine}</td><td className={`diff-code diff-split-code diff-line-${row.left?.kind ?? 'blank'}`}>{row.left && <><span className="diff-marker" aria-hidden="true">{marker(row.left)}</span>{row.left.text}</>}</td><td className={`diff-number diff-line-${row.right?.kind ?? 'blank'}`}>{row.right?.newLine}</td><td className={`diff-code diff-split-code diff-line-${row.right?.kind ?? 'blank'}`}>{row.right && <><span className="diff-marker" aria-hidden="true">{marker(row.right)}</span>{row.right.text}</>}</td></tr>)}
    </tbody></table></div>}
    {pages > 1 && <div className="diff-toolbar"><PulseButton disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</PulseButton><span>第 {currentPage + 1} / {pages} 页</span><PulseButton disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</PulseButton></div>}
  </section>
}
