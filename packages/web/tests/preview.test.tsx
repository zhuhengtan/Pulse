import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PreviewDock } from '../src/PreviewDock.js'
import { FilePreview } from '../src/FilePreview.js'
import { browserAddress } from '../src/browserAddress.js'
import { workbenchFixture, workbenchProject } from './fixtures/workbench.js'
import { previewKey, readPreviewState } from '../src/previewState.js'
import { ConversationArtifacts } from '../src/ConversationArtifacts.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport } from '../src/transport.js'
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.stubGlobal('WebSocket', class { close() {} }); localStorage.clear(); Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const transport: PulseWebTransport = { request: async path => new Response(path.includes('runId=second') ? 'Second result' : '# First result', { headers: { 'Content-Type': 'text/markdown' } }), subscribe: () => () => {} }
it('keeps same-name artifacts in distinct tabs, persists selection, and closes without deleting files', async () => {
  const navigate = vi.fn()
  const view = render(<PulseDesignSystem><PreviewDock scope="conversation" conversationId="conversation" projectId="p" transport={transport} localAdmin position={new URLSearchParams('artifact=report.md&artifactRun=first')} onNavigate={navigate} /></PulseDesignSystem>)
  await screen.findByRole('heading', { name: 'First result' })
  view.rerender(<PulseDesignSystem><PreviewDock scope="conversation" conversationId="conversation" projectId="p" transport={transport} localAdmin position={new URLSearchParams('artifact=report.md&artifactRun=second')} onNavigate={navigate} /></PulseDesignSystem>)
  await screen.findByText('Second result'); expect(screen.getAllByRole('tab', { name: 'report.md' })).toHaveLength(2)
  expect(readPreviewState('conversation').tabs).toHaveLength(2)
  expect(readPreviewState('other').tabs).toHaveLength(0)
  fireEvent.click(screen.getAllByRole('button', { name: '关闭 report.md 标签' })[1]!)
  await screen.findByRole('heading', { name: 'First result' })
  expect(readPreviewState('conversation').tabs).toHaveLength(1)
  expect(navigate).toHaveBeenCalled()
})
it('opens delivery cards in the right panel without an inline text request', async () => {
  const request = vi.fn(), navigate = vi.fn()
  render(<ConversationArtifacts conversationId="c" runId="r" artifacts={[{path:'image.png',runId:'r',absolutePath:'/work/image.png',workspaceState:'isolated'}]} transport={{request,subscribe:()=>()=>{}}} onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', {name:'查看'}))
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({workspace:'preview',artifact:'image.png',artifactRun:'r'}))
  expect(request).not.toHaveBeenCalled()
})
it('shows a changed-artifact error and still offers download and refresh', async () => {
  const request = vi.fn(async () => new Response('{}', {status:409}))
  render(<FilePreview target={{kind:'file',conversationId:'c',runId:'r',path:'report.md'}} transport={{request,subscribe:()=>()=>{}}} onBrowser={async()=>{}} />)
  await screen.findByText('文件已发生变化，请重新核对本轮产物。')
  expect(screen.getByRole('button',{name:'下载'})).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));await waitFor(()=>expect(request).toHaveBeenCalledTimes(2))
})
it('does not collide project files with turn artifacts', () => {
  expect(previewKey({kind:'file',projectId:'p',path:'same.md'})).not.toBe(previewKey({kind:'file',conversationId:'c',runId:'r',path:'same.md'}))
})
it('explains an unavailable backend preview endpoint instead of reporting a missing file', async () => {
  const request = vi.fn(async () => Response.json({error:'NOT_FOUND'}, {status:404}))
  render(<FilePreview target={{kind:'file',conversationId:'c',runId:'r',path:'image.svg'}} transport={{request,subscribe:()=>()=>{}}} onBrowser={async()=>{}} />)
  await screen.findByText('当前后台尚未支持文件预览接口，请更新并重启开发后台后重试。')
  expect(screen.queryByText('文件不存在、目录不可用或无权读取。')).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
})

it('opens tools in the same standalone window without nested tabs or an expansion control', async () => {
  const fixture = workbenchFixture()
  const view = render(<PulseDesignSystem><PreviewDock scope="new" projectId="pulse" project={workbenchProject} transport={fixture.transport} localAdmin /></PulseDesignSystem>)
  expect(screen.getByRole('complementary', { name: '独立工作区' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '文件', exact: true }))
  await screen.findByText('README.md')
  expect(view.container.querySelectorAll('[role="tablist"]')).toHaveLength(1)
  expect(view.container.querySelector('.workbench-header')).toBeNull()
  expect(screen.queryByRole('button', { name: '展开', exact: true })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '新建标签页', exact: true }))
  await screen.findByRole('heading', { name: '工具', exact: true })
  expect(screen.getByRole('tab', { name: '文件', exact: true })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭 新标签页 标签', exact: true }))
  await screen.findByText('README.md')
  expect(readPreviewState('new').tabs).toEqual([{ kind:'tool', tool:'files' }])
})
it('keeps an empty new page available after closing the final document', async () => {
  render(<PreviewDock scope="last" projectId="p" transport={transport} localAdmin position={new URLSearchParams('file=report.md')} />)
  await screen.findByRole('heading', { name: 'First result' })
  fireEvent.click(screen.getByRole('button', { name: '关闭 report.md 标签' }))
  await screen.findByRole('heading', { name: '工具' })
  expect(screen.getByRole('textbox', { name: '浏览器地址' })).toBeTruthy()
})
it('normalizes browser addresses and rejects credentials and non-web protocols', () => {
  expect(browserAddress('localhost:5173')).toBe('http://localhost:5173/')
  expect(browserAddress('127.0.0.1:7333/test')).toBe('http://127.0.0.1:7333/test')
  expect(browserAddress('example.com')).toBe('https://example.com/')
  expect(() => browserAddress('file:///etc/passwd')).toThrow()
  expect(() => browserAddress('https://user:password@example.com')).toThrow()
})
