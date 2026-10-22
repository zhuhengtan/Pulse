import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { parseDiff, splitDiff } from '../src/diff.js'
import { DiffViewer } from '../src/DiffViewer.js'
import { PreviewDock } from '../src/PreviewDock.js'
import { Markdown } from '../src/Markdown.js'
import { changedToolPaths, RunTraceView, type TraceState } from '../src/RunTrace.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { readPreviewState } from '../src/previewState.js'
const patch = 'diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -5,3 +5,4 @@\n context\n-old\n+new\n+extra\n tail\n'
beforeEach(() => { localStorage.clear(); Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }) })
afterEach(cleanup)
it('parses old/new hunk line numbers and aligns replacements with unmatched additions', () => {
  const lines = parseDiff(patch)
  expect(lines.filter(line => line.kind !== 'meta')).toEqual([
    {kind:'context',text:'context',oldLine:5,newLine:5}, {kind:'delete',text:'old',oldLine:6}, {kind:'add',text:'new',newLine:6}, {kind:'add',text:'extra',newLine:7}, {kind:'context',text:'tail',oldLine:7,newLine:8},
  ])
  const rows = splitDiff(lines).filter(line => line.kind === 'pair')
  expect(rows[1]).toMatchObject({left:{text:'old',oldLine:6},right:{text:'new',newLine:6}})
  expect(rows[2]?.left).toBeUndefined();expect(rows[2]?.right?.newLine).toBe(7)
})
it('does not mistake source lines starting with +++/--- for file headers, and supports zero-length hunks', () => {
  expect(parseDiff('@@ -1 +1 @@\n---source\n+++source\n').filter(line=>line.kind!=='meta')).toEqual([{kind:'delete',text:'--source',oldLine:1},{kind:'add',text:'++source',newLine:1}])
  expect(parseDiff('@@ -0,0 +1 @@\n+created\n').at(-1)).toEqual({kind:'add',text:'created',newLine:1})
  expect(parseDiff('@@ -1 +0,0 @@\n-deleted\n').at(-1)).toEqual({kind:'delete',text:'deleted',oldLine:1})
})
it('renders highlighted numbered lines, switches to split view and escapes source HTML', () => {
  const view = render(<DiffViewer text={patch.replace('new','<img src=x onerror=alert(1)>')} />)
  expect(view.container.querySelectorAll('.diff-line-add')).toHaveLength(2)
  expect(screen.getByText('+2')).toBeTruthy(); expect(screen.getByText('−1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'左右对照'}))
  expect(screen.getByRole('columnheader',{name:'修改前'})).toBeTruthy()
  expect(screen.getByRole('button',{name:'左右对照'}).getAttribute('aria-pressed')).toBe('true')
  expect(view.container.querySelector('img')).toBeNull()
  expect(localStorage.getItem('pulse-diff-mode')).toBe('split')
})
it('opens a persisted diff tab using the conversation execution directory endpoint', async () => {
  const request = vi.fn(async () => Response.json({diff:patch}))
  render(<PreviewDock scope="c" conversationId="c" projectId="p" transport={{request,subscribe:()=>()=>{}}} localAdmin position={new URLSearchParams('diff=main.ts')} />)
  await screen.findByRole('tab',{name:'main.ts · Diff'})
  await screen.findByText('old')
  expect(request.mock.calls[0]?.[0]).toContain('/api/conversations/c/git/diff?path=main.ts')
  await waitFor(()=>expect(readPreviewState('c').tabs[0]).toMatchObject({kind:'diff',conversationId:'c',path:'main.ts'}))
})
it('adds one-click diff actions to assistant file links and successful modification records', () => {
  const open = vi.fn()
  const view=render(<Markdown text="修改 [main.ts](main.ts)" onFileClick={()=>{}} onDiffClick={open} />)
  fireEvent.click(screen.getByRole('button',{name:'查看 main.ts 的差异'}));expect(open).toHaveBeenCalledWith('main.ts');view.unmount()
  const trace:TraceState={order:['main'],lanes:{main:{id:'main',label:'主任务',status:'succeeded',steps:[{id:'edit',kind:'tool',tool:'fs.apply_patch',status:'succeeded',args:{path:'main.ts'}}]}},outcome:'succeeded'}
  render(<PulseDesignSystem><RunTraceView trace={trace} running={false} onDiffClick={open} /></PulseDesignSystem>)
  fireEvent.click(screen.getByRole('button',{name:'查看 main.ts 的差异'}));expect(open).toHaveBeenCalledTimes(2)
  expect(changedToolPaths({id:'stage',kind:'tool',tool:'fs.stage',status:'succeeded',args:{operation:'append',path:'draft.ts'}})).toEqual([])
  expect(changedToolPaths({id:'failed',kind:'tool',tool:'fs.write',status:'failed',args:{path:'bad.ts'}})).toEqual([])
})
it('paginates large changes instead of silently dropping lines', () => {
  const text='@@ -0,0 +1,700 @@\n'+Array.from({length:700},(_,i)=>`+line ${i+1}`).join('\n')
  render(<DiffViewer text={text} />)
  expect(screen.getByText('第 1 / 2 页')).toBeTruthy();expect(screen.queryByText('line 700')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));expect(screen.getByText('line 700')).toBeTruthy()
})
