import { createRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseButton, PulseInput, PulseTextArea, usePulseDialogs } from '../src/PulseControls.js'
import { WorkbenchPanel } from '../src/WorkbenchPanel.js'
import { ArchivePage } from '../src/ArchivePage.js'
import { workbenchFixture, workbenchProject } from './fixtures/workbench.js'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
  const originalStyle = window.getComputedStyle.bind(window)
  window.getComputedStyle = element => originalStyle(element)
  Element.prototype.scrollTo = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('WebSocket', class { close() {} })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Workbench({ readOnly = false, project = workbenchProject }: { readOnly?: boolean; project?: typeof workbenchProject }) {
  const [tab, setTab] = useState<'files' | 'git' | 'preview' | 'terminal' | 'automation'>('files')
  const [fixture] = useState(() => workbenchFixture(readOnly))
  return <WorkbenchPanel project={project} transport={fixture.transport} localAdmin canUseTerminal={false} tab={tab} setTab={setTab} onClose={() => {}} />
}

describe('Ant Design controls and workbench behavior', () => {
  it('preserves native input refs and form submission through the shared controls', () => {
    const input = createRef<HTMLInputElement>(), textarea = createRef<HTMLTextAreaElement>(), submit = vi.fn(event => event.preventDefault())
    render(<PulseDesignSystem><form onSubmit={submit}><PulseInput ref={input} aria-label="Title" /><PulseTextArea ref={textarea} aria-label="Body" /><PulseButton>Submit</PulseButton><PulseButton type="button">Keep editing</PulseButton></form></PulseDesignSystem>)
    expect(input.current).toBeInstanceOf(HTMLInputElement)
    expect(textarea.current).toBeInstanceOf(HTMLTextAreaElement)
    fireEvent.change(input.current!, { target: { value: 'New title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('returns the edited prompt value on Enter and returns null on cancel', async () => {
    const result = vi.fn()
    function Prompt() {
      const dialogs = usePulseDialogs()
      return <PulseButton onClick={async () => result(await dialogs.prompt('Project name', 'Existing'))}>Rename</PulseButton>
    }
    render(<PulseDesignSystem><Prompt /></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const field = await screen.findByRole('textbox', { name: 'Project name' })
    fireEvent.change(field, { target: { value: 'Updated' } })
    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(result).toHaveBeenLastCalledWith('Updated'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消', exact: true }))
    await waitFor(() => expect(result).toHaveBeenLastCalledWith(null))
  })

  it('shows folder/file icons and preserves directory, breadcrumb and file-preview navigation', async () => {
    const view = render(<PulseDesignSystem><Workbench /></PulseDesignSystem>)
    await screen.findByText('docs')
    expect(view.container.querySelectorAll('.workspace-file-tree .anticon-folder')).toHaveLength(2)
    expect(view.container.querySelector('.workspace-file-tree .anticon-file')).toBeTruthy()
    fireEvent.click(screen.getByText('docs'))
    fireEvent.click(await screen.findByText('plan.md'))
    await screen.findByText('Verified workspace document')
    fireEvent.click(screen.getByRole('button', { name: '← 文件列表' }))
    fireEvent.click(screen.getByRole('button', { name: '项目', exact: true }))
    await screen.findByText('README.md')
    fireEvent.click(screen.getByRole('tab', { name: 'Git', exact: true }))
    await screen.findByText('分支 · main')
    expect(view.container.querySelector('.git-file-path')?.textContent).toBe('packages/runtime/src/dsl/program.ts')
    expect(view.container.querySelector('.git-file-status')?.textContent).toBe('M')
    fireEvent.click(screen.getByRole('radio', { name: '已暂存', exact: true }))
    await screen.findByText('+verified diff')
  })

  it('uses Ant Design automation dropdowns and retains read-only action restrictions', async () => {
    const view = render(<PulseDesignSystem><Workbench readOnly /></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('tab', { name: '自动化', exact: true }))
    await screen.findAllByText(/Existing document/)
    expect(view.container.querySelector('select')).toBeNull()
    expect(view.container.querySelectorAll('.automation-controls .ant-select')).toHaveLength(2)
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '浏览器连接模式' }))
    fireEvent.click(await screen.findByText('现有 Chrome/Edge'))
    await waitFor(() => expect(screen.getByRole('combobox', { name: '浏览器连接模式' }).closest('.ant-select')?.textContent).toContain('现有 Chrome/Edge'))
    expect((screen.getByRole('button', { name: '打开浏览器' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '连接桌面' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('配对设备控制权限'))
    const checkbox = await screen.findByRole('checkbox', { name: 'Test phone' })
    expect((checkbox as HTMLInputElement).checked).toBe(false)
  })

  it('separates staged, unstaged and untracked Git entries without changing Git state', async () => {
    const view = render(<PulseDesignSystem><Workbench /></PulseDesignSystem>)
    fireEvent.click(screen.getByRole('tab', { name: 'Git', exact: true }))
    await screen.findByText('packages/runtime/src/dsl/program.ts')
    expect(screen.queryByText('staged.ts')).toBeNull()
    expect(screen.getByText('new.ts')).toBeTruthy()
    expect(screen.getByText('both.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '已暂存', exact: true }))
    expect(screen.getByText('staged.ts')).toBeTruthy()
    expect(screen.getByText('both.ts')).toBeTruthy()
    expect(screen.queryByText('new.ts')).toBeNull()
    expect(screen.queryByText('packages/runtime/src/dsl/program.ts')).toBeNull()
    expect(view.container.querySelector('.git-file-status')?.textContent).toBe('A')
  })

  it('enables preview immediately after registering its URL without waiting for a project-list refresh', async () => {
    const view = render(<PulseDesignSystem><Workbench /></PulseDesignSystem>)
    await screen.findByText('docs')
    fireEvent.click(screen.getByRole('tab', { name: '预览', exact: true }))
    fireEvent.change(screen.getByPlaceholderText('http://127.0.0.1:5173'), { target: { value: 'http://127.0.0.1:5179' } })
    fireEvent.click(screen.getByRole('button', { name: '登记', exact: true }))
    await screen.findByTitle('Pulse 预览')
    expect((screen.getByRole('button', { name: '刷新', exact: true }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/登记本机项目开发服务器后即可预览/)).toBeNull()
    view.rerender(<PulseDesignSystem><Workbench project={{ ...workbenchProject, previewUrl: 'http://127.0.0.1:5179' }} /></PulseDesignSystem>)
    expect(screen.getByTitle('Pulse 预览')).toBeTruthy()
  })

  it('waits for an explicit Ant Design confirmation and does not delete on cancel', async () => {
    const fixture = workbenchFixture()
    render(<PulseDesignSystem><ArchivePage transport={fixture.transport} onBack={() => {}} onChanged={() => {}} onOpen={() => {}} /></PulseDesignSystem>)
    fireEvent.click(await screen.findByRole('button', { name: '删除', exact: true }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: '取消', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fixture.requests.some(request => request.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '确认', exact: true }))
    await waitFor(() => expect(fixture.requests.filter(request => request.method === 'DELETE')).toHaveLength(1))
  })
})
